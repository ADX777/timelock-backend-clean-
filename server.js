const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// Log startup
console.log('Starting server...');

// Env vars
const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS || '5WX95FT-6GP42SK-H8BEAW6-9HFNTEN';
const NOWPAYMENTS_SECRET = process.env.NOWPAYMENTS_SECRET || 'uKC6vWHrVb2Qtc8yt8j0sH1OQgMSH05x';
const TATUM_API_KEY = process.env.TATUM_API_KEY;
const BSC_PRIVATE_KEY = process.env.YOUR_BSC_WALLET_PRIVATE_KEY;
const USDT_WALLET = process.env.USDT_WALLET;
const RAILWAY_PUBLIC_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN || 'https://timelock-backend-production.up.railway.app';

// Log env vars (ẩn private key)
console.log('Env vars:', {
  NOWPAYMENTS_API_KEY: NOWPAYMENTS_API_KEY ? 'Set' : 'Missing',
  NOWPAYMENTS_SECRET: NOWPAYMENTS_SECRET ? 'Set' : 'Missing',
  TATUM_API_KEY: TATUM_API_KEY ? 'Set' : 'Missing',
  USDT_WALLET: USDT_WALLET ? 'Set' : 'Missing',
  RAILWAY_PUBLIC_DOMAIN
});

// Temp storage
const tempStorage = {};

// Catch unhandled errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught Error:', err.message, err.stack);
});

// Preview data
app.post('/api/preview-data', (req, res) => {
  console.log('Preview request:', req.body);
  const { encryptedPayload } = req.body;
  if (!encryptedPayload) return res.status(400).json({ error: 'Missing encryptedPayload' });
  const hexData = Buffer.from(encryptedPayload).toString('hex');
  res.json({ previewData: hexData });
});

// Create payment
app.post('/api/create-payment', async (req, res) => {
  console.log('Create payment request:', req.body);
  const { amount, noteId, encryptedPayload } = req.body;
  if (!amount || !noteId || !encryptedPayload) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const response = await axios.post('https://api.nowpayments.io/v1/payment', {
      price_amount: amount,
      price_currency: 'usdtbep20',
      pay_currency: 'usdtbep20',
      order_id: noteId,
      order_description: `Timelock Note ${noteId}`,
      ipn_callback_url: `${RAILWAY_PUBLIC_DOMAIN}/webhook/nowpayments`,
      payout_address: USDT_WALLET,
    }, { headers: { 'x-api-key': NOWPAYMENTS_API_KEY } });
    console.log('NowPayments response:', response.data);
    tempStorage[noteId] = { encryptedPayload };
    res.json({
      qrCode: response.data.qr_code,
      paymentAddress: response.data.payment_address,
      paymentId: response.data.payment_id
    });
  } catch (error) {
    console.error('NowPayments error:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data?.message || 'Lỗi tạo thanh toán' });
  }
});

// Webhook
app.post('/webhook/nowpayments', async (req, res) => {
  console.log('Webhook received:', req.body);
  const sig = req.headers['x-nowpayments-sig'];
  const hmac = crypto.createHmac('sha512', NOWPAYMENTS_SECRET);
  const calcSig = hmac.update(JSON.stringify(req.body, Object.keys(req.body).sort())).digest('hex');
  if (sig !== calcSig) {
    console.error('Invalid webhook signature');
    return res.status(401).send('Invalid signature');
  }
  if (req.body.payment_status === 'finished') {
    const { order_id } = req.body;
    const encryptedPayload = tempStorage[order_id]?.encryptedPayload;
    if (!encryptedPayload) {
      console.error('No data for order:', order_id);
      return res.status(404).send('No data');
    }
    try {
      const tatumRes = await axios.post('https://api.tatum.io/v3/record', {
        chain: 'BSC',
        data: Buffer.from(encryptedPayload).toString('hex'),
        fromPrivateKey: BSC_PRIVATE_KEY,
        to: '0x0000000000000000000000000000000000000000',
      }, { headers: { 'x-api-key': TATUM_API_KEY } });
      console.log('Tatum tx:', tatumRes.data.txId);
      tempStorage[order_id].txHash = tatumRes.data.txId;
    } catch (error) {
      console.error('Tatum error:', error.response?.data || error.message);
    }
  }
  res.status(200).send('OK');
});

// Get txHash
app.post('/api/get-tx', (req, res) => { // Thay get thành post nếu cần
  const { noteId } = req.body; // Để an toàn, dùng body
  console.log('Get tx request:', noteId);
  const txHash = tempStorage[noteId]?.txHash;
  if (txHash) res.json({ txHash });
  else res.status(404).json({ error: 'Chưa xác nhận' });
});

const server = app.listen(process.env.PORT || 3000, () => console.log('Back-end running'));

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
