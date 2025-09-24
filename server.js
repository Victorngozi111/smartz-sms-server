// --- server.js ---
// This is the complete, final code for the smspva.com API.

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
const SMSPVA_API_KEY = process.env.SMSPVA_API_KEY; // Using your smspva.com API Key
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

if (!SMSPVA_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY || !PAYSTACK_SECRET_KEY) {
    console.error("FATAL ERROR: Missing one or more required environment variables.");
    process.exit(1);
}

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const SMS_API_URL = 'http://api.smspva.com/server.php';
const PROFIT_MARGIN = 1.5; // This sets your profit to 50%. You can increase this to 2.0 (100% profit) later!
const NGN_PER_COIN = 15;

// --- API ENDPOINTS ---
app.get('/', (req, res) => res.send("Verify SMS Server is running with smspva.com API."));

app.get('/api/getCountries', async (req, res) => {
    try {
        const response = await axios.get(`${SMS_API_URL}?metod=get_countries&api_key=${SMSPVA_API_KEY}`);
        if (!response.data || response.data.response === 0) {
            throw new Error("Invalid country data from SMS provider");
        }
        const countries = response.data.map(country => ({
            id: country.id,
            name: country.name_en
        })).sort((a, b) => a.name.localeCompare(b.name));
        
        res.json({ success: true, data: countries });
    } catch (error) {
        console.error("Error fetching countries:", error.message);
        res.status(500).json({ success: false, message: 'Could not fetch countries.' });
    }
});

app.get('/api/getPrice', async (req, res) => {
    const { service, country } = req.query;
    if (!service || !country) {
        return res.status(400).json({ success: false, message: 'Service and country are required.' });
    }

    try {
        const response = await axios.get(`${SMS_API_URL}?metod=get_service_price&country=${country}&service=${service}&api_key=${SMSPVA_API_KEY}`);
        const priceData = response.data;
        if (priceData.response !== 1 || !priceData.price) {
            return res.status(404).json({ success: false, message: 'This service is not available in the selected country.' });
        }
        
        const basePriceInCoins = parseFloat(priceData.price);
        const finalPrice = Math.ceil(basePriceInCoins * PROFIT_MARGIN);
        res.json({ success: true, price: finalPrice });

    } catch (error) {
        console.error(`Error getting price for ${service} in ${country}:`, error.message);
        res.status(500).json({ success: false, message: 'Could not fetch price from provider.' });
    }
});

app.post('/api/getNumber', async (req, res) => {
    const { service, country, userId } = req.body;
    if (!service || !country || !userId) {
        return res.status(400).json({ success: false, message: 'Service, country, and user ID are required.' });
    }

    try {
        const priceResponse = await axios.get(`${SMS_API_URL}?metod=get_service_price&country=${country}&service=${service}&api_key=${SMSPVA_API_KEY}`);
        if (priceResponse.data.response !== 1) throw new Error('Service not available.');
        const finalPrice = Math.ceil(parseFloat(priceResponse.data.price) * PROFIT_MARGIN);

        const { data: profile, error: profileError } = await supabaseAdmin.from('profiles').select('coins').eq('id', userId).single();
        if (profileError) throw new Error('Could not retrieve user profile.');
        if (profile.coins < finalPrice) {
            return res.status(402).json({ success: false, message: 'Insufficient coins. Please add more to your balance.' });
        }

        const numberResponse = await axios.get(`${SMS_API_URL}?metod=get_number&country=${country}&service=${service}&api_key=${SMSPVA_API_KEY}`);
        const data = numberResponse.data;

        if (data.response === 1) {
            const newBalance = profile.coins - finalPrice;
            await supabaseAdmin.from('profiles').update({ coins: newBalance }).eq('id', userId);
            
            const serviceName = service.charAt(0).toUpperCase() + service.slice(1);
            res.json({ success: true, number: data.number, orderId: data.id, serviceName });
        } else {
            throw new Error(`Failed to get number: ${data.error_msg || 'Provider error'}`);
        }

    } catch (error) {
        console.error("Get number error:", error.message);
        res.status(500).json({ success: false, message: error.message || 'An internal server error occurred.' });
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

        const { data: profile, error: profileError } = await supabaseAdmin.from('profiles').select('coins').eq('id', userId).single();
        if (profileError || !profile) return res.status(404).json({ success: false, message: 'User not found.' });
        
        const newTotalCoins = profile.coins + coinsToAdd;
        const { error: updateError } = await supabaseAdmin.from('profiles').update({ coins: newTotalCoins }).eq('id', userId);
        if (updateError) throw new Error("Failed to update user's coin balance.");

        res.json({ success: true, message: `${coinsToAdd} coins added successfully.` });
    } catch (error) {
        console.error("Payment verification error:", error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, message: 'An error occurred during payment verification.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Verify SMS server live on port ${PORT}`));
