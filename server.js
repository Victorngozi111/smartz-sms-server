// --- server.js ---
// This is the complete, corrected code for your server.

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();

// --- NEW & IMPROVED CORS CONFIGURATION ---
// This safely allows your Netlify site to access the server.
const allowedOrigins = ['https://verifyssim.netlify.app'];
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin) || origin.endsWith('--verifyssim.netlify.app')) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  }
};
app.use(cors(corsOptions));
app.use(express.json());

// --- LOAD ENVIRONMENT VARIABLES & INITIALIZE SUPABASE ADMIN ---
const SMS_API_KEY = process.env.SMS_API_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const SMS_API_URL = 'https://api.sms-activate.org/stubs/handler_api.php';

// --- API ENDPOINTS ---
app.get('/', (req, res) => res.send("Verify SMS Server is running."));

app.get('/api/getCountries', async (req, res) => {
    console.log("Request received for /api/getCountries");
    try {
        const response = await axios.get(`${SMS_API_URL}?api_key=${SMS_API_KEY}&action=getCountries`);
        if (typeof response.data !== 'object' || response.data === null) {
            throw new Error("Invalid data from provider");
        }
        const countryNames = Object.values(response.data).map(c => c.eng).filter(Boolean);
        console.log(`Successfully fetched ${countryNames.length} countries.`);
        res.json({ success: true, data: countryNames });
    } catch (error) {
        console.error("Error in /api/getCountries:", error.message);
        res.status(500).json({ success: false, message: 'Could not fetch countries.' });
    }
});

// IMPORTANT: Make sure you have the other endpoints (getPrice, getNumber, verify-payment)
// from the previous server code I gave you. They are required for the app to function.

// ... (Your other endpoints: /api/getPrice, /api/getNumber, /api/verify-payment)

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Verify SMS server live on port ${PORT}`));
