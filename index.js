const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const Stripe = require("stripe");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Middleware
app.use(cors());

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));

const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

// async function run() {
//     try {
//         await client.connect();

client.connect(() => {
    console.log('connecting to mongodb..')
}).catch(console.dir)

const db = client.db(process.env.AUTH_DB_NAME);
const galleryCollection = db.collection("gallery");
const userCollection = db.collection("user");
const bookingCollection = db.collection("bookings");
const sessionCollection = db.collection("session");

const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
        return res.status(401).json({ message: "unauthorized access" });
    }

    try {
        const session = await sessionCollection.findOne({ token });
        if (!session) {
            return res.status(401).json({ message: "unauthorized access" });
        }

        const user = await userCollection.findOne({ _id: session.userId }); // userCollection, not usersCollection
        if (!user) {
            return res.status(401).json({ message: "unauthorized access" });
        }

        req.user = user;
        next();
    } catch (err) {
        console.error("verifyToken error:", err);
        res.status(500).json({ message: "auth check failed" });
    }
};

const verifyAdmin = async (req, res, next) => {
    if (req.user?.role !== 'admin') {
        return res.status(403).send({ message: 'forbidden access' });
    }
    next();
}

app.get('/users', async (req, res) => {
    try {
        const users = await userCollection.find({}, {
            projection: { password: 0 }
        }).toArray();

        res.status(200).json(users);
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch users' });
    }
});

app.patch('/users/:id/role', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { role } = req.body;

        if (!['user', 'admin'].includes(role)) {
            return res.status(400).json({ success: false, message: 'Invalid role' });
        }

        const result = await userCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { role } }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        res.status(200).json({ success: true, message: 'User role updated' });
    } catch (error) {
        console.error('Update role error:', error);
        res.status(500).json({ success: false, message: 'Failed to update role' });
    }
});

app.delete('/users/:id', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const result = await userCollection.deleteOne({
            _id: new ObjectId(id)
        });

        if (result.deletedCount === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        res.status(200).json({ success: true, message: 'User deleted successfully' });
    } catch (error) {
        console.error('Delete user error:', error);
        res.status(500).json({ success: false, message: 'Failed to delete user' });
    }
});



app.get('/analytics/overview', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const totalUsers = await userCollection.countDocuments();
        const totalAdmins = await userCollection.countDocuments({ role: 'admin' });
        const regularUsers = totalUsers - totalAdmins;

        const totalGalleryItems = await galleryCollection.countDocuments();
        const paidItems = await galleryCollection.countDocuments({ isPaid: true });
        const freeItems = totalGalleryItems - paidItems;

        // Breakdown by category
        const categoryBreakdown = await galleryCollection.aggregate([
            { $group: { _id: "$category", count: { $sum: 1 } } },
            { $sort: { count: -1 } }
        ]).toArray();


        const potentialRevenueAgg = await galleryCollection.aggregate([
            { $match: { isPaid: true } },
            { $group: { _id: null, total: { $sum: "$price" } } }
        ]).toArray();
        const potentialRevenue = potentialRevenueAgg[0]?.total || 0;

        // Recent signups
        const recentUsers = await userCollection
            .find({}, { projection: { password: 0 } })
            .sort({ _id: -1 })
            .limit(5)
            .toArray();

        // Recent gallery uploads
        const recentGallery = await galleryCollection
            .find()
            .sort({ createdAt: -1 })
            .limit(5)
            .toArray();

        res.status(200).json({
            success: true,
            data: {
                totalUsers,
                totalAdmins,
                regularUsers,
                totalGalleryItems,
                paidItems,
                freeItems,
                potentialRevenue,
                categoryBreakdown,
                recentUsers,
                recentGallery,
            },
        });
    } catch (error) {
        console.error('Analytics overview error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch analytics' });
    }
});


// POST: Upload/Add new event/photo
app.post('/gallery', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { title, description, category, isPaid, price, imageUrl } = req.body;

        if (!title || !imageUrl) {
            return res.status(400).json({
                success: false,
                message: "Title and Image URL/Base64 are required."
            });
        }

        if (isPaid && (price === undefined || price <= 0)) {
            return res.status(400).json({
                success: false,
                message: "A valid price in USD is required for paid items."
            });
        }

        // Document structure
        const newEvent = {
            title,
            description: description || "",
            category: category || "Other",
            isPaid: Boolean(isPaid),
            price: isPaid ? Number(price) : 0,
            imageUrl,
            createdAt: new Date(),
        };

        const result = await galleryCollection.insertOne(newEvent);

        res.status(201).json({
            success: true,
            message: "Photo uploaded successfully!",
            insertedId: result.insertedId,
        });
    } catch (error) {
        console.error("Error inserting event:", error);
        res.status(500).json({
            success: false,
            message: "Server error occurred while saving the event."
        });
    }
});

// GET: Fetch all gallery/photos (for your Gallery page)
app.get('/gallery', async (req, res) => {
    try {
        const gallery = await galleryCollection.find().sort({ createdAt: -1 }).toArray();
        res.status(200).json(gallery);
    } catch (error) {
        console.error("Error fetching gallery:", error);
        res.status(500).json({ success: false, message: "Server error fetching gallery." });
    }
});

// GET: Fetch a single photo by ID
app.get('/gallery/:id', async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: "Invalid ID format." });
        }

        const photo = await galleryCollection.findOne({ _id: new ObjectId(id) });

        if (!photo) {
            return res.status(404).json({ success: false, message: "Photo not found." });
        }

        res.status(200).json(photo);
    } catch (error) {
        console.error("Error fetching photo:", error);
        res.status(500).json({ success: false, message: "Server error fetching photo details." });
    }
});

//  PUT: Update photo details by ID
app.put('/gallery/:id', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: "Invalid ID format." });
        }

        const { title, description, category, isPaid, price, imageUrl } = req.body;

        const updateDoc = {
            $set: {
                ...(title && { title }),
                ...(description !== undefined && { description }),
                ...(category && { category }),
                ...(isPaid !== undefined && { isPaid: Boolean(isPaid) }),
                ...(price !== undefined && { price: isPaid ? Number(price) : 0 }),
                ...(imageUrl && { imageUrl }),
                updatedAt: new Date(),
            }
        };

        const result = await galleryCollection.updateOne(
            { _id: new ObjectId(id) },
            updateDoc
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ success: false, message: "Photo not found." });
        }

        res.status(200).json({
            success: true,
            message: "Photo updated successfully!",
            modifiedCount: result.modifiedCount
        });
    } catch (error) {
        console.error("Error updating photo:", error);
        res.status(500).json({ success: false, message: "Server error updating photo." });
    }
});

// DELETE: Delete a photo by ID
app.delete('/gallery/:id', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: "Invalid ID format." });
        }

        const result = await galleryCollection.deleteOne({ _id: new ObjectId(id) });

        if (result.deletedCount === 0) {
            return res.status(404).json({ success: false, message: "Photo not found." });
        }

        res.status(200).json({
            success: true,
            message: "Photo deleted successfully!"
        });
    } catch (error) {
        console.error("Error deleting photo:", error);
        res.status(500).json({ success: false, message: "Server error deleting photo." });
    }
});


// bookings
app.post("/api/bookings", verifyToken, async (req, res) => {
    try {
        const { fullName, email, phone, eventDate } = req.body;

        if (!fullName || !email || !phone) {
            return res.status(400).json({
                success: false,
                message: "Full name, email, and phone are required.",
            });
        }

        const booking = {
            ...req.body,
            status: "Pending",
            createdAt: new Date(),
        };

        const result = await bookingCollection.insertOne(booking);

        res.status(201).json({
            success: true,
            message: "Booking request received.",
            insertedId: result.insertedId,
        });
    } catch (error) {
        console.error("Create booking error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to create booking.",
        });
    }
});

// ADMIN — list all bookings, latest first
app.get("/api/bookings", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const bookings = await bookingCollection
            .find()
            .sort({ createdAt: -1 })
            .toArray();

        res.status(200).json(bookings);
    } catch (error) {
        console.error("Get bookings error:", error);
        res.status(500).json({ success: false, message: "Failed to fetch bookings." });
    }
});

// ADMIN — single booking detail
app.get("/api/bookings/:id", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: "Invalid ID format." });
        }

        const booking = await bookingCollection.findOne({ _id: new ObjectId(id) });

        if (!booking) {
            return res.status(404).json({ success: false, message: "Booking not found." });
        }

        res.status(200).json(booking);
    } catch (error) {
        console.error("Get booking error:", error);
        res.status(500).json({ success: false, message: "Failed to fetch booking." });
    }
});

// ADMIN — update status (Pending / Confirmed / Cancelled / etc.)
app.patch("/api/bookings/:id", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: "Invalid ID format." });
        }

        const allowedStatuses = ["Pending", "Confirmed", "Cancelled", "Completed"];
        if (!allowedStatuses.includes(status)) {
            return res.status(400).json({ success: false, message: "Invalid status." });
        }

        const result = await bookingCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status } }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ success: false, message: "Booking not found." });
        }

        res.status(200).json({ success: true, message: "Booking status updated." });
    } catch (error) {
        console.error("Update booking error:", error);
        res.status(500).json({ success: false, message: "Failed to update booking." });
    }
});

// ADMIN — delete a booking
app.delete("/api/bookings/:id", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: "Invalid ID format." });
        }

        const result = await bookingCollection.deleteOne({ _id: new ObjectId(id) });

        if (result.deletedCount === 0) {
            return res.status(404).json({ success: false, message: "Booking not found." });
        }

        res.status(200).json({ success: true, message: "Booking deleted." });
    } catch (error) {
        console.error("Delete booking error:", error);
        res.status(500).json({ success: false, message: "Failed to delete booking." });
    }
});



app.post("/create-checkout-session", async (req, res) => {
    try {
        const { _id, title, price, imageUrl } = req.body;

        // 1. Basic validation
        if (!title || price === undefined || price === null) {
            return res.status(400).json({ error: "Missing required fields: title or price" });
        }

        const parsedPrice = Number(price);
        if (isNaN(parsedPrice) || parsedPrice <= 0) {
            return res.status(400).json({
                error: "Free or invalid priced events cannot be processed through Stripe."
            });
        }

        const frontendUrl = process.env.FRONTEND_URL || req.headers.origin || "http://localhost:3000";


        const isValidHttpUrl = (url) => {
            try {
                const parsed = new URL(url);
                return parsed.protocol === "http:" || parsed.protocol === "https:";
            } catch {
                return false;
            }
        };

        const validImages = imageUrl && isValidHttpUrl(imageUrl) ? [imageUrl] : [];


        const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            line_items: [
                {
                    price_data: {
                        currency: "usd",
                        product_data: {
                            name: title,
                            ...(validImages.length > 0 && { images: validImages }),
                        },
                        unit_amount: Math.round(parsedPrice * 100),
                    },
                    quantity: 1,
                },
            ],
            mode: "payment",

            metadata: {
                eventId: _id || "",
            },
            success_url: `${frontendUrl}/payment-success?session_id={CHECKOUT_SESSION_ID}&eventId=${_id || ""}`,
            cancel_url: `${frontendUrl}/events/${_id || ""}?canceled=true`,
        });

        return res.status(200).json({ id: session.id, url: session.url });
    } catch (error) {
        console.error("Stripe Checkout Error:", error);
        return res.status(500).json({
            success: false,
            error: error.message || "Internal Server Error during checkout generation"
        });
    }
});


// await client.db("admin").command({ ping: 1 });
// console.log("Pinged your deployment. You successfully connected to MongoDB!");

//     } catch (err) {
//     console.error("Failed to start server configurations:", err);
// }
// }

app.get('/', (req, res) => {
    res.send('Server is Serving...');
});

// run();

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`)
});

module.exports = app;