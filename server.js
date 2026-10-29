const express = require('express');
const cors = require('cors');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- CONFIGURATION ---
const MONGODB_URI = process.env.MONGODB_URI;
const PORT = process.env.PORT || 10000;

let db, wallets, deposits, purchases, conversions, settings;

// --- DATABASE CONNECTION ---
async function connectDB() {
    if (!MONGODB_URI) {
        console.error("❌ MONGODB_URI is missing from Environment Variables");
        return;
    }
    try {
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        db = client.db('airswap'); // Dedicated database for this project
        
        wallets = db.collection('wallets');
        deposits = db.collection('deposits');
        purchases = db.collection('purchases');
        conversions = db.collection('conversions');
        settings = db.collection('settings');

        // Create Default Settings if none exist
        const existingSettings = await settings.findOne({ key: 'app_settings' });
        if (!existingSettings) {
            await settings.insertOne({
                key: 'app_settings',
                paybill: '756756',
                account: '17690003',
                safaricomReceiving: '0750140380', // Update this if you change it in frontend
                airtelReceiving: '0733123456'     // Update this if you change it in frontend
            });
        }

        console.log('✅ MongoDB Connected');
    } catch (err) {
        console.error('❌ MongoDB Connection Failed:', err.message);
    }
}
connectDB();

// --- SERVE FRONTEND ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve Admin HTML if you have it in the same folder
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});


// ==========================================
// USER ROUTES
// ==========================================

// 1. Get App Settings (Paybill info for frontend)
app.get('/api/settings', async (req, res) => {
    try {
        const currentSettings = await settings.findOne({ key: 'app_settings' });
        res.json({ 
            paybill: currentSettings.paybill, 
            account: currentSettings.account 
        });
    } catch (e) {
        res.status(500).json({ error: 'Failed to load settings' });
    }
});

// 2. Get User Wallet Balance
app.get('/api/wallet/:phone', async (req, res) => {
    try {
        const wallet = await wallets.findOne({ phone: req.params.phone });
        res.json({ balance: wallet ? wallet.balance : 0 });
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch wallet' });
    }
});

// 3. Submit a Deposit Request (User clicks "Done, I Have Paid")
app.post('/api/deposit/request', async (req, res) => {
    try {
        const { phone, amount, mpesaCode } = req.body;
        
        // Validate limits
        if (!amount || amount < 100 || amount > 70000) {
            return res.status(400).json({ error: 'Deposit must be between KES 100 and KES 70,000' });
        }

        await deposits.insertOne({
            phone: phone,
            amount: Number(amount),
            mpesaCode: mpesaCode || 'PENDING',
            status: 'pending',
            createdAt: new Date()
        });

        res.json({ success: true, message: "Deposit request submitted. Admin will verify and credit your wallet." });
    } catch (e) {
        res.status(500).json({ error: 'Failed to submit deposit' });
    }
});

// 4. Process a Purchase (Airtime, Data, Vouchers)
app.post('/api/purchase', async (req, res) => {
    try {
        const { phone, amount, description } = req.body;
        
        if (!phone || !amount) return res.status(400).json({ error: 'Missing data' });

        const wallet = await wallets.findOne({ phone: phone });
        const currentBalance = wallet ? wallet.balance : 0;

        if (currentBalance < amount) {
            return res.status(400).json({ error: 'Insufficient wallet balance. Please deposit first.' });
        }

        // Deduct balance
        await wallets.updateOne(
            { phone: phone },
            { $inc: { balance: -Number(amount) } },
            { upsert: true }
        );

        // Log purchase
        await purchases.insertOne({
            phone: phone,
            amount: Number(amount),
            description: description,
            status: 'completed',
            createdAt: new Date()
        });

        res.json({ success: true, message: `Success! ${description} processed. KES ${amount} deducted.` });
    } catch (e) {
        res.status(500).json({ error: 'Purchase failed' });
    }
});

// 5. Submit an Airtime Conversion Request
app.post('/api/convert', async (req, res) => {
    try {
        const { senderPhone, receiverPhone, network, airtimeAmount } = req.body;
        
        // Validate limits
        if (!airtimeAmount || airtimeAmount < 100 || airtimeAmount > 70000) {
            return res.status(400).json({ error: 'Conversion must be between KES 100 and KES 70,000' });
        }

        const payoutAmount = Number(airtimeAmount) * 0.95;

        await conversions.insertOne({
            senderPhone,
            receiverPhone,
            network,
            airtimeAmount: Number(airtimeAmount),
            payoutAmount: payoutAmount,
            status: 'pending',
            mpesaCode: null,
            createdAt: new Date()
        });

        res.json({ success: true, message: "Request sent! Admin will verify and send your M-Pesa." });
    } catch (e) {
        res.status(500).json({ error: 'Failed to submit conversion' });
    }
});

// 6. Get User History
app.get('/api/history/:phone', async (req, res) => {
    try {
        const phone = req.params.phone;

        const userDeposits = await deposits.find({ phone, status: 'approved' }).toArray();
        const userPurchases = await purchases.find({ phone }).toArray();
        const userConversions = await conversions.find({ receiverPhone: phone }).toArray();

        let history = [
            ...userDeposits.map(d => ({ type: 'Deposit', amount: d.amount, desc: 'Wallet Top-up', date: d.createdAt, color: 'green' })),
            ...userPurchases.map(p => ({ type: 'Purchase', amount: -p.amount, desc: p.description, date: p.createdAt, color: 'red' })),
            ...userConversions.map(c => ({ type: 'Conversion', amount: c.payoutAmount, desc: `Converted ${c.airtimeAmount} ${c.network} airtime`, date: c.createdAt, color: 'green' }))
        ].sort((a, b) => new Date(b.date) - new Date(a.date)); // Sort newest first

        res.json(history);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch history' });
    }
});


// ==========================================
// ADMIN ROUTES (For your Admin Dashboard)
// ==========================================

// 1. Get Pending Deposits
app.get('/api/admin/pending-deposits', async (req, res) => {
    try {
        const pending = await deposits.find({ status: 'pending' }).sort({ createdAt: -1 }).toArray();
        res.json(pending);
    } catch (e) {
        res.status(500).json({ error: 'Failed to load deposits' });
    }
});

// 2. Approve a Deposit (Credit User Wallet)
app.post('/api/admin/approve-deposit', async (req, res) => {
    try {
        const { id, phone, amount } = req.body;
        
        // Mark as approved
        await deposits.updateOne(
            { _id: new ObjectId(id) }, 
            { $set: { status: 'approved', approvedAt: new Date() } }
        );

        // Credit wallet
        await wallets.updateOne(
            { phone: phone }, 
            { $inc: { balance: Number(amount) } }, 
            { upsert: true }
        );

        res.json({ success: true, message: 'Deposit approved and wallet credited!' });
    } catch (e) {
        res.status(500).json({ error: 'Failed to approve deposit' });
    }
});

// 3. Get Pending Conversions
app.get('/api/admin/pending', async (req, res) => {
    try {
        const pending = await conversions.find({ status: 'pending' }).sort({ createdAt: -1 }).toArray();
        res.json(pending);
    } catch (e) {
        res.status(500).json({ error: 'Failed to load conversions' });
    }
});

// 4. Approve a Conversion (Mark as Paid)
app.post('/api/admin/approve', async (req, res) => {
    try {
        const { id, mpesaCode } = req.body;
        
        await conversions.updateOne(
            { _id: new ObjectId(id) }, 
            { $set: { status: 'completed', mpesaCode: mpesaCode, completedAt: new Date() } }
        );
        
        res.json({ success: true, message: 'Conversion marked as completed!' });
    } catch (e) {
        res.status(500).json({ error: 'Failed to update conversion' });
    }
});

// 5. Get Admin Settings
app.get('/api/admin/settings', async (req, res) => {
    try {
        const currentSettings = await settings.findOne({ key: 'app_settings' });
        res.json(currentSettings);
    } catch (e) {
        res.status(500).json({ error: 'Failed to load settings' });
    }
});

// 6. Update Admin Settings
app.post('/api/admin/settings', async (req, res) => {
    try {
        const { paybill, account, safaricomReceiving, airtelReceiving } = req.body;
        
        await settings.updateOne(
            { key: 'app_settings' },
            { $set: { paybill, account, safaricomReceiving, airtelReceiving } }
        );
        
        res.json({ success: true, message: 'Settings updated successfully!' });
    } catch (e) {
        res.status(500).json({ error: 'Failed to update settings' });
    }
});


// --- START SERVER ---
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));