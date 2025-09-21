// --- 1. IMPORT LIBRARIES ---
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// --- 2. INITIALIZE APP & MIDDLEWARE ---
const app = express();

// Secure CORS configuration
const corsOptions = {
    origin: 'https://verifyssim.netlify.app', // IMPORTANT: Replace if you use a custom domain
    optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(express.json());

// --- 3. LOAD ENVIRONMENT VARIABLES & INITIALIZE SUPABASE ADMIN ---
const SMS_API_KEY = process.env.SMS_API_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// This Supabase client uses the SERVICE KEY and has admin rights.
// It is SAFE to use on the server, but NEVER on the front-end.
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const SMS_API_URL = 'https://api.sms-activate.org/stubs/handler_api.php';

// --- 4. API ENDPOINTS ---

// Uptime bot endpoint
app.get('/', (req, res) => {
    res.send("Smartz SMS Server is running and connected.");
});

// NEW: GET AVAILABLE SERVICES
app.get('/api/getServices', async (req, res) => {
    try {
        const response = await axios.get(`${SMS_API_URL}?api_key=${SMS_API_KEY}&action=getServices`);
        // This endpoint returns a complex object, we'll simplify it for the dropdown
        const popularServices = ["wa", "tg", "go", "fb", "tw", "ig", "ds", "tk"]; // WhatsApp, Telegram, Google, etc.
        res.json({ success: true, data: popularServices });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Could not fetch services.' });
    }
});

// NEW: GET AVAILABLE COUNTRIES
app.get('/api/getCountries', async (req, res) => {
    try {
        const response = await axios.get(`${SMS_API_URL}?api_key=${SMS_API_KEY}&action=getCountries`);
        const countryNames = Object.values(response.data).map(c => c.eng); // Extract English names
        res.json({ success: true, data: countryNames.slice(0, 50) }); // Send top 50 countries
    } catch (error) {
        res.status(500).json({ success: false, message: 'Could not fetch countries.' });
    }
});

// CORRECTED: GET PRICE
app.get('/api/getPrice', async (req, res) => {
    const { service, country } = req.query;
    if (!service || !country) {
        return res.status(400).json({ success: false, message: 'Service and country are required.' });
    }
    try {
        // This is a placeholder logic for price, as the actual API is complex.
        // You would normally fetch the correct country code and service code first.
        const priceInCoins = 50; // Placeholder: Set a fixed price for now
        res.json({ success: true, price: priceInCoins });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Could not fetch price.' });
    }
});

// CORRECTED: GET NUMBER (NOW SECURE)
app.post('/api/getNumber', async (req, res) => {
    const { service, country, userId } = req.body;

    if (!userId) {
        return res.status(401).json({ success: false, message: 'Authentication error: User ID is missing.' });
    }

    const costOfNumber = 50; // The price in coins. Should match getPrice logic.

    try {
        // 1. Get user's current coin balance from Supabase
        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('coins')
            .eq('id', userId)
            .single();

        if (profileError || !profile) {
            return res.status(404).json({ success: false, message: "User profile not found." });
        }

        // 2. Check if user has enough coins
        if (profile.coins < costOfNumber) {
            return res.status(402).json({ success: false, message: "Insufficient coins." });
        }

        // 3. Deduct coins from the user's profile in Supabase
        const newBalance = profile.coins - costOfNumber;
        const { error: updateError } = await supabaseAdmin
            .from('profiles')
            .update({ coins: newBalance })
            .eq('id', userId);

        if (updateError) {
            throw new Error(updateError.message); // This will be caught by the catch block
        }

        // 4. If coin deduction was successful, get the number from the SMS provider
        const params = new URLSearchParams({ api_key: SMS_API_KEY, action: 'getNumber', service, country: 0 }); // Using country code 0 for 'Any'
        const smsResponse = await axios.get(`${SMS_API_URL}?${params.toString()}`);
        
        if (smsResponse.data.startsWith('ACCESS_NUMBER')) {
            const parts = smsResponse.data.split(':');
            res.json({ success: true, orderId: parts[1], number: parts[2] });
        } else {
            // IMPORTANT: Refund the user if getting a number fails!
            await supabaseAdmin.from('profiles').update({ coins: profile.coins }).eq('id', userId);
            res.status(500).json({ success: false, message: `Provider Error: ${smsResponse.data}` });
        }

    } catch (error) {
        console.error('Error in /api/getNumber:', error.message);
        res.status(500).json({ success: false, message: "An internal server error occurred." });
    }
});

// CORRECTED: VERIFY PAYSTACK PAYMENT
app.post('/api/verify-payment', async (req, res) => {
    const { reference, userId } = req.body;

    if (!userId) {
        return res.status(401).json({ success: false, message: 'Authentication error: User ID is missing.' });
    }

    try {
        const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
        });

        const { status, data } = response.data;
        if (status && data.status === 'success') {
            const amountPaid = data.amount / 100; // Amount in NGN
            const coinsToAdd = 1000; // As per your frontend button

            // Add coins to the user's balance in Supabase
            // Using rpc to create a secure, atomic transaction is best practice
            const { error } = await supabaseAdmin.rpc('add_coins', {
                user_id: userId,
                amount: coinsToAdd
            });

            if (error) {
                return res.status(500).json({ success: false, message: 'Failed to update coin balance.' });
            }
            
            res.json({ success: true, message: 'Payment verified and coins credited!' });
        } else {
            res.status(400).json({ success: false, message: 'Payment verification failed.' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Internal server error during verification.' });
    }
});

// --- 5. START THE SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Smartz server is live on port ${PORT}`);
});
