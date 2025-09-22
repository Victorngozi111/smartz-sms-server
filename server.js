// --- server.js ---
// This is the complete, corrected code for your server.

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();

// --- CORS CONFIGURATION ---
const allowedOrigins = ['https://verifyssim.netlify.app', 'http://127.0.0.1:5500']; // Add your frontend URLs
const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || origin.endsWith('--verifyssim.netlify.app')) {
      return callback(null, true);
    }
    return callback(new Error('Request blocked by CORS'));
  }
};
app.use(cors(corsOptions));
app.use(express.json());

// --- LOAD ENVIRONMENT VARIABLES & INITIALIZE CLIENTS ---
const SMS_API_KEY = process.env.SMS_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

if (!SMS_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY || !PAYSTACK_SECRET_KEY) {
    console.error("FATAL ERROR: Missing one or more required environment variables.");
    process.exit(1);
}

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const SMS_API_URL = 'https://api.sms-activate.org/stubs/handler_api.php';
const PROFIT_MARGIN = 1.4; // 40% profit
const NGN_PER_COIN = 15; // Base price in NGN for one coin (the price you show the user)

// --- API ENDPOINTS ---
app.get('/', (req, res) => res.send("Verify SMS Server is running."));

app.get('/api/getCountries', async (req, res) => {
    try {
        const response = await axios.get(`${SMS_API_URL}?api_key=${SMS_API_KEY}&action=getCountries`);
        if (typeof response.data !== 'object' || response.data === null) {
            throw new Error("Invalid data from SMS provider");
        }
        // The API returns an object where keys are country IDs and values are country data
        const countries = Object.entries(response.data).map(([id, countryData]) => ({
            id: id,
            name: countryData.eng
        })).filter(c => c.name); // Filter out any entries without an English name
        
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
        const response = await axios.get(`${SMS_API_URL}?api_key=${SMS_API_KEY}&action=getPrices&service=${service}&country=${country}`);
        
        if (typeof response.data !== 'object' || response.data === null) {
            throw new Error("Invalid price data from SMS provider");
        }

        // The response structure is { "country": { "service": { "cost": X, "count": Y } } }
        const priceData = response.data[country]?.[service];
        if (!priceData || !priceData.cost) {
            return res.status(404).json({ success: false, message: 'This service is not available in the selected country.' });
        }

        const basePriceInCoins = parseFloat(priceData.cost);
        const finalPrice = Math.ceil(basePriceInCoins * PROFIT_MARGIN); // Apply 40% profit and round up

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
        // 1. Get the price with profit margin
        const priceResponse = await axios.get(`${SMS_API_URL}?api_key=${SMS_API_KEY}&action=getPrices&service=${service}&country=${country}`);
        const priceData = priceResponse.data[country]?.[service];
        if (!priceData || !priceData.cost) {
            return res.status(404).json({ success: false, message: 'Service not available in this country.' });
        }
        const finalPrice = Math.ceil(parseFloat(priceData.cost) * PROFIT_MARGIN);

        // 2. Check user's balance
        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('coins')
            .eq('id', userId)
            .single();

        if (profileError || !profile) {
            return res.status(404).json({ success: false, message: 'User profile not found.' });
        }

        if (profile.coins < finalPrice) {
            return res.status(402).json({ success: false, message: 'Insufficient coins. Please add more to your balance.' });
        }

        // 3. Deduct coins from user's balance
        const newBalance = profile.coins - finalPrice;
        const { error: updateError } = await supabaseAdmin
            .from('profiles')
            .update({ coins: newBalance })
            .eq('id', userId);

        if (updateError) {
            throw new Error('Failed to update user balance.');
        }

        // 4. Request the number from the SMS provider
        const numberResponse = await axios.get(`${SMS_API_URL}?api_key=${SMS_API_KEY}&action=getNumber&service=${service}&country=${country}`);
        const responseText = numberResponse.data.toString();
        
        if (responseText.startsWith('ACCESS_NUMBER')) {
            const [, orderId, number] = responseText.split(':');
            res.json({ success: true, number, orderId });
        } else {
            // If getting number failed, refund the user
            await supabaseAdmin.from('profiles').update({ coins: profile.coins }).eq('id', userId);
            throw new Error(`Failed to get number: ${responseText}`);
        }

    } catch (error) {
        console.error("Get number error:", error.message);
        res.status(500).json({ success: false, message: error.message || 'An internal server error occurred.' });
    }
});

app.post('/api/verify-payment', async (req, res) => {
    const { reference, userId } = req.body;
    if (!reference || !userId) {
        return res.status(400).json({ success: false, message: 'Reference and userId are required.' });
    }

    try {
        // 1. Verify transaction with Paystack
        const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
            headers: {
                Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
            }
        });

        const { status, data } = response.data;
        if (!status || data.status !== 'success') {
            return res.status(400).json({ success: false, message: 'Payment verification failed.' });
        }

        // 2. Calculate coins to add
        const amountPaidNGN = data.amount / 100; // Paystack amount is in kobo
        const coinsToAdd = Math.floor(amountPaidNGN / NGN_PER_COIN);

        if (coinsToAdd < 1) {
            return res.status(400).json({ success: false, message: 'Amount is too small to purchase any coins.' });
        }

        // 3. Add coins to user's profile
        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('coins')
            .eq('id', userId)
            .single();

        if (profileError || !profile) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        const newTotalCoins = profile.coins + coinsToAdd;

        const { error: updateError } = await supabaseAdmin
            .from('profiles')
            .update({ coins: newTotalCoins })
            .eq('id', userId);

        if (updateError) {
            throw new Error("Failed to update user's coin balance.");
        }

        res.json({ success: true, message: `${coinsToAdd} coins added successfully.` });

    } catch (error) {
        console.error("Payment verification error:", error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, message: 'An error occurred during payment verification.' });
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Verify SMS server live on port ${PORT}`));
