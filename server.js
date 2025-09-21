// --- 1. IMPORT REQUIRED LIBRARIES ---
const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config(); // This loads your .env file for local testing

// --- 2. INITIALIZE THE APP ---
const app = express();
app.use(cors()); // Allow your Netlify front-end to talk to this server
app.use(express.json()); // Allow the server to understand JSON data

// --- 3. SECURELY LOAD YOUR API KEYS ---
// This reads the secret keys from the Environment Variables on Render.
const SMS_ACTIVATE_API_KEY = process.env.SMS_API_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const SMS_API_URL = 'https://api.sms-activate.org/stubs/handler_api.php';

// --- 4. BUSINESS LOGIC & CONFIGURATION ---
const RUB_TO_NGN_RATE = 15; // Example: 1 RUB = 15 NGN. You should update this.
const PROFIT_MARGIN = 1.5; // We charge 1.5x what it costs us (50% profit).

// --- 5. SIMULATED DATABASE ---
// In a real production app, this would be a real database (like PostgreSQL on Render).
let users = [
    // Add a test user to start
    { email: 'test@test.com', password: 'password', coins: 500 }
];

// --- 6. API ENDPOINTS (The Server's "Brain") ---

// UPTIME BOT ENDPOINT: A simple endpoint for the bot to ping.
app.get('/', (req, res) => {
    res.send("Smartz Server is awake and running!");
});

// SIGNUP ENDPOINT
app.post('/api/signup', (req, res) => {
    const { email, password } = req.body;
    // In a real app, you MUST hash passwords and check if the email is already taken.
    users.push({ email, password, coins: 100 }); // Give 100 free coins on signup
    console.log('New user signed up:', email);
    res.status(201).json({ success: true, message: 'Account created! Please login.' });
});

// LOGIN ENDPOINT
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const user = users.find(u => u.email === email && u.password === password);
    if (user) {
        // In a real app, you would generate and send a JWT token for security.
        res.json({ success: true, message: 'Login successful', coins: user.coins });
    } else {
        res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
});

// GET PRICE ENDPOINT
app.get('/api/getPrice', async (req, res) => {
    const { service, country } = req.query;
    if (!service || !country) {
        return res.status(400).json({ message: 'Service and country are required.' });
    }

    try {
        const response = await axios.get(`${SMS_API_URL}?api_key=${SMS_ACTIVATE_API_KEY}&action=getPrices&service=${service}&country=${country}`);
        const prices = response.data.prices;
        if (prices && prices[country] && prices[country][service]) {
            const costInRub = prices[country][service].cost;
            const costInNgn = costInRub * RUB_TO_NGN_RATE;
            const finalPriceInCoins = Math.ceil(costInNgn * PROFIT_MARGIN); // Your selling price

            res.json({ success: true, priceInCoins: finalPriceInCoins });
        } else {
            res.status(404).json({ success: false, message: 'Price not found.' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Could not fetch price from provider.' });
    }
});

// GET NUMBER ENDPOINT
app.post('/api/getNumber', (req, res) => {
    // In a real app, you would authenticate the user here first.
    const { service, country } = req.body;
    // Re-check price, check user coins, then purchase...
    const params = new URLSearchParams({ api_key: SMS_ACTIVATE_API_KEY, action: 'getNumber', service, country });
    axios.get(`${SMS_API_URL}?${params.toString()}`).then(response => {
        if (response.data.startsWith('ACCESS_NUMBER')) {
            const parts = response.data.split(':');
            res.json({ success: true, activationId: parts[1], phoneNumber: parts[2] });
        } else {
            res.status(400).json({ success: false, message: `API Error: ${response.data}` });
        }
    }).catch(error => res.status(500).json({ success: false, message: 'Provider server error.' }));
});

// VERIFY PAYSTACK PAYMENT ENDPOINT
app.post('/api/verify-payment', async (req, res) => {
    const { reference } = req.body;
    try {
        const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
        });

        const { status, data } = response.data;
        if (status && data.status === 'success') {
            // SECURITY CHECK: You should also check if `data.amount` matches what the user was supposed to pay.
            console.log(`Payment successful for reference: ${reference}. Amount: ${data.amount / 100} NGN`);
            // TODO: Find the user in your REAL database and add their purchased coins.
            res.json({ success: true, message: 'Payment verified and coins credited.' });
        } else {
            res.status(400).json({ message: 'Payment verification failed.' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Internal server error during verification.' });
    }
});

// --- 7. START THE SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Smartz server is live and running on port ${PORT}`);
});