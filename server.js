// --- server.js ---
// This is the complete, final code for the smspva.com API, including the "get SMS code" feature.

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();

// --- CORS CONFIGURATION ---
const allowedOrigins = ['https://verifyssim.netlify.app', 'http://127.0.0.1:5500'];
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin) || origin.endsWith('--verifyssim.netlify.app')) {
      return callback(null, true);
    }
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
const PROFIT_MARGIN = 1.5;
const NGN_PER_COIN = 15;

// --- API ENDPOINTS ---
app.get('/', (req, res) => res.send("Verify SMS Server is running with smspva.com API."));

app.get('/api/getCountries', async (req, res) => {
    try {
        const response = await axios.get(`${SMS_API_URL}?metod=get_countries&api_key=${SMSPVA_API_KEY}`);
        if (!response.data || response.data.response === "0") throw new Error("Could not fetch countries from provider.");
        const countries = response.data.map(c => ({ id: c.id, name: c.name_en })).sort((a, b) => a.name.localeCompare(b.name));
        res.json({ success: true, data: countries });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/getPrice', async (req, res) => {
    const { service, country } = req.query;
    if (!service || !country) return res.status(400).json({ success: false, message: 'Service and country are required.' });
    try {
        const response = await axios.get(`${SMS_API_URL}?metod=get_service_price&country=${country}&service=${service}&api_key=${SMSPVA_API_KEY}`);
        const priceData = response.data;
        if (priceData.response !== 1 || !priceData.price) return res.status(404).json({ success: false, message: 'Service not available in this country.' });
        
        const basePrice = parseFloat(priceData.price);
        const finalPrice = Math.ceil(basePrice * PROFIT_MARGIN);
        res.json({ success: true, price: finalPrice });
    } catch (error) { res.status(500).json({ success: false, message: 'Could not fetch price.' }); }
});

app.post('/api/getNumber', async (req, res) => {
    const { service, country, userId } = req.body;
    if (!service || !country || !userId) return res.status(400).json({ success: false, message: 'Missing required fields.' });

    try {
        const priceResponse = await axios.get(`${SMS_API_URL}?metod=get_service_price&country=${country}&service=${service}&api_key=${SMSPVA_API_KEY}`);
        if (priceResponse.data.response !== 1) throw new Error('Could not get price for this service.');
        const finalPrice = Math.ceil(parseFloat(priceResponse.data.price) * PROFIT_MARGIN);

        const { data: profile } = await supabaseAdmin.from('profiles').select('coins').eq('id', userId).single();
        if (!profile || profile.coins < finalPrice) return res.status(402).json({ success: false, message: 'Insufficient coins.' });

        const numberResponse = await axios.get(`${SMS_API_URL}?metod=get_number&country=${country}&service=${service}&api_key=${SMSPVA_API_KEY}`);
        const data = numberResponse.data;

        if (data.response === 1) {
            const newBalance = profile.coins - finalPrice;
            await supabaseAdmin.from('profiles').update({ coins: newBalance }).eq('id', userId);
            
            // Getting the full service name from the service code, e.g. "opt20" -> "WhatsApp"
            const serviceList = { opt20: 'WhatsApp', opt2: 'Telegram', opt1: 'Facebook', opt16: 'Instagram', opt29: 'TikTok', opt4: 'Google', opt3: 'Tinder', opt33: 'Netflix' };
            const serviceName = serviceList[service] || service;

            res.json({ success: true, number: data.number, orderId: data.id, serviceName: serviceName });
        } else {
            throw new Error(data.error_msg || 'Provider error getting number.');
        }
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// --- NEW FEATURE: Get SMS Code Endpoint ---
app.get('/api/getStatus', async (req, res) => {
    const { orderId } = req.query;
    if (!orderId) return res.status(400).json({ success: false, message: 'Order ID is required.' });

    try {
        const response = await axios.get(`${SMS_API_URL}?metod=get_sms&id=${orderId}&api_key=${SMSPVA_API_KEY}`);
        const data = response.data;

        if (data.response === "1") { // SMS has arrived
            res.json({ success: true, status: 'SUCCESS', code: data.sms });
        } else if (data.response === "2") { // Still waiting
             res.json({ success: true, status: 'WAITING', message: 'Waiting for SMS...' });
        } else { // Error or other status
            throw new Error(data.error_msg || 'Could not get status.');
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
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
        if (coinsToAdd < 1) return res.status(400).json({ success: false, message: 'Amount is too small to purchase any coins.' });

        const { data: profile } = await supabaseAdmin.from('profiles').select('coins').eq('id', userId).single();
        if (!profile) return res.status(404).json({ success: false, message: 'User not found.' });
        
        const newTotalCoins = profile.coins + coinsToAdd;
        await supabaseAdmin.from('profiles').update({ coins: newTotalCoins }).eq('id', userId);

        res.json({ success: true, message: `${coinsToAdd} coins added successfully.` });
    } catch (error) { res.status(500).json({ success: false, message: 'An error occurred during verification.' }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Verify SMS server live on port ${PORT}`));
