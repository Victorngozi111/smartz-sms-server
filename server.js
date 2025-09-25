// --- server.js ---
// FINAL VERSION: Implements your new business rule: (API Price in NGN) + 1500 NGN Profit.

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();

// --- CORS CONFIGURATION ---
// This is updated to correctly allow your Netlify site to connect.
const allowedOrigins = ['https://verifyssim.netlify.app', 'http://127.0.0.1:5500'];
const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    // Handle Netlify's preview deploy URLs
    if (origin.endsWith('--verifyssim.netlify.app')) {
      return callback(null, true);
    }
    console.log(`CORS blocked request from origin: ${origin}`);
    return callback(new Error('Request blocked by CORS'));
  }
};
app.use(cors(corsOptions));
app.use(express.json());

// --- LOAD ENVIRONMENT VARIABLES & INITIALIZE CLIENTS ---
const SMSPVA_API_KEY = process.env.SMSPVA_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

if (!SMSPVA_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY || !PAYSTACK_SECRET_KEY) {
    console.error("FATAL ERROR: Missing one or more required environment variables.");
    process.exit(1);
}

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const SMS_API_URL = 'http://api.smspva.com/server.php';

// --- YOUR NEW BUSINESS RULES (ALL IN ONE PLACE) ---
const NGN_PER_COIN = 15;
const USD_TO_NGN_CONVERSION_RATE = 1500; // Your rule: $1 = 1500 NGN
const FIXED_PROFIT_NGN = 1500;           // Your rule: Add 1500 NGN profit
const RUB_TO_USD_RATE = 0.011;           // Real-time conversion for API price

// --- API ENDPOINTS ---
app.get('/', (req, res) => res.send("Verify SMS Server is running with smspva.com API."));

// Helper function for the new pricing model
const calculateFinalPriceInCoins = (basePriceInRub) => {
    const basePriceInUsd = basePriceInRub * RUB_TO_USD_RATE;

    // Special rule: $5 = 10,000 NGN
    if (basePriceInUsd >= 4.95 && basePriceInUsd <= 5.05) { // Check if price is around $5
        const finalPriceInNgn = 10000;
        return Math.ceil(finalPriceInNgn / NGN_PER_COIN);
    }
    
    // Convert base price to NGN
    const basePriceInNgn = basePriceInUsd * USD_TO_NGN_CONVERSION_RATE;
    
    // Add your profit
    const finalPriceInNgn = basePriceInNgn + FIXED_PROFIT_NGN;
    
    // Convert final NGN price to coins
    const finalPriceInCoins = Math.ceil(finalPriceInNgn / NGN_PER_COIN);
    return finalPriceInCoins;
};

app.get('/api/getServices', async (req, res) => {
    try {
        const response = await axios.get(`${SMS_API_URL}?metod=get_services_list&api_key=${SMSPVA_API_KEY}`);
        if (!response.data || response.data.response === "0") throw new Error("Could not fetch services.");
        // We add the quantity property here, which you wanted to display
        const services = response.data.map(s => ({ code: s.id, name: s.name, quantity: s.quantity }));
        res.json({ success: true, data: services });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/getCountries', async (req, res) => {
    const { service } = req.query;
    if (!service) return res.status(400).json({ success: false, message: 'A service code is required.' });
    try {
        const response = await axios.get(`${SMS_API_URL}?metod=get_country_list&service=${service}&api_key=${SMSPVA_API_KEY}`);
        if (!response.data || response.data.response === "0") return res.json({ success: true, data: [] });
        const countries = response.data.map(c => ({ id: c.id, name: c.name_en })).sort((a, b) => a.name.localeCompare(b.name));
        res.json({ success: true, data: countries });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/getPrice', async (req, res) => {
    const { service, country } = req.query;
    if (!service || !country) return res.status(400).json({ success: false, message: 'Service and country are required.' });
    try {
        const response = await axios.get(`${SMS_API_URL}?metod=get_service_price&country=${country}&service=${service}&api_key=${SMSPVA_API_KEY}`);
        if (response.data.response !== 1 || !response.data.price) return res.status(404).json({ success: false, message: 'Service not available in this country.' });
        
        const basePriceInRub = parseFloat(response.data.price);
        const finalPriceInCoins = calculateFinalPriceInCoins(basePriceInRub);

        res.json({ success: true, data: { price: finalPriceInCoins } }); // Send price inside a 'data' object
    } catch (error) { res.status(500).json({ success: false, message: 'Could not fetch price.' }); }
});

app.post('/api/getNumber', async (req, res) => {
    const { service, country, userId, serviceName } = req.body;
    if (!service || !country || !userId) return res.status(400).json({ success: false, message: 'Missing required fields.' });
    try {
        const priceResponse = await axios.get(`${SMS_API_URL}?metod=get_service_price&country=${country}&service=${service}&api_key=${SMSPVA_API_KEY}`);
        if (priceResponse.data.response !== 1) throw new Error('Could not get price for this service.');

        const basePriceInRub = parseFloat(priceResponse.data.price);
        const finalPriceInCoins = calculateFinalPriceInCoins(basePriceInRub);

        const { data: profile } = await supabaseAdmin.from('profiles').select('coins').eq('id', userId).single();
        if (!profile || profile.coins < finalPriceInCoins) return res.status(402).json({ success: false, message: 'Insufficient coins.' });

        const numberResponse = await axios.get(`${SMS_API_URL}?metod=get_number&country=${country}&service=${service}&api_key=${SMSPVA_API_KEY}`);
        if (numberResponse.data.response === 1) {
            const newBalance = profile.coins - finalPriceInCoins;
            await supabaseAdmin.from('profiles').update({ coins: newBalance }).eq('id', userId);
            res.json({ success: true, data: { number: numberResponse.data.number, orderId: numberResponse.data.id, serviceName: serviceName } });
        } else {
            throw new Error(numberResponse.data.error_msg || 'Provider error getting number.');
        }
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/getStatus', async (req, res) => {
    const { orderId } = req.query;
    if (!orderId) return res.status(400).json({ success: false, message: 'Order ID is required.' });
    try {
        const response = await axios.get(`${SMS_API_URL}?metod=get_sms&id=${orderId}&api_key=${SMSPVA_API_KEY}`);
        const data = response.data;
        if (data.response === "1") res.json({ success: true, data: { status: 'SUCCESS', code: data.sms } });
        else if (data.response === "2") res.json({ success: true, data: { status: 'WAITING', message: 'Waiting for SMS...' } });
        else throw new Error(data.error_msg || 'Could not get status.');
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/verify-payment', async (req, res) => {
    const { reference, userId } = req.body;
    if (!reference || !userId) return res.status(400).json({ success: false, message: 'Reference and userId are required.' });
    try {
        const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } });
        const { status, data } = response.data;
        if (!status || data.status !== 'success') return res.status(400).json({ success: false, message: 'Payment verification failed.' });

        const amountPaidNGN = data.amount / 100;
        const coinsToAdd = Math.floor(amountPaidNGN / NGN_PER_COIN);
        if (coinsToAdd < 1) return res.status(400).json({ success: false, message: 'Amount is too small.' });

        const { data: profile } = await supabaseAdmin.from('profiles').select('coins').eq('id', userId).single();
        if (!profile) return res.status(404).json({ success: false, message: 'User not found.' });
        
        const newTotalCoins = profile.coins + coinsToAdd;
        await supabaseAdmin.from('profiles').update({ coins: newTotalCoins }).eq('id', userId);
        res.json({ success: true, message: `${coinsToAdd} coins added successfully.` });
    } catch (error) { res.status(500).json({ success: false, message: 'An error occurred during verification.' }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Verify SMS server live on port ${PORT}`));
