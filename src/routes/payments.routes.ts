import { Router, Response } from 'express';
import * as crypto from 'crypto';
import axios from 'axios';
import { db } from '../config/firebase';
import { verifyToken, AuthRequest } from '../middleware/verifyToken';

const router = Router();

// ── Cashfree helpers ──────────────────────────────────────────────────────────
function cashfreeHeaders() {
  return {
    'x-client-id':     process.env.CASHFREE_APP_ID || '',
    'x-client-secret': process.env.CASHFREE_SECRET_KEY || '',
    'x-api-version':   '2023-08-01',
    'Content-Type':    'application/json',
  };
}

function cashfreeBase() {
  // Use sandbox for test, production otherwise
  return process.env.CASHFREE_ENV === 'production'
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg';
}

// ── POST /api/payments/create-order ──────────────────────────────────────────
router.post('/create-order', verifyToken, async (req: AuthRequest, res: Response) => {
  if (req.user?.role !== 'sender')
    return res.status(403).json({ error: 'Only senders can initiate payment' });

  const { shipmentId } = req.body;
  if (!shipmentId) return res.status(400).json({ error: 'shipmentId is required' });

  try {
    const doc = await db().collection('shipments').doc(shipmentId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Shipment not found' });
    const ship = doc.data()!;
    if (ship.senderId !== req.user!.uid)   return res.status(403).json({ error: 'Not your shipment' });
    if (ship.status !== 'accepted')        return res.status(400).json({ error: 'Shipment must be accepted before payment' });
    if (ship.paymentStatus === 'paid')     return res.status(400).json({ error: 'Already paid' });

    const appId     = process.env.CASHFREE_APP_ID || '';
    const secretKey = process.env.CASHFREE_SECRET_KEY || '';

    // Mock mode when credentials not set
    if (!appId || appId.includes('YOUR')) {
      const mockSessionId = `mock_session_${Date.now()}`;
      await doc.ref.update({ cashfreeOrderId: `mock_order_${Date.now()}` });
      return res.json({
        orderId:          `mock_order_${Date.now()}`,
        paymentSessionId: mockSessionId,
        amount:           ship.totalAmount / 100,
        currency:         'INR',
        mock:             true,
      });
    }

    // Real Cashfree order
    const senderDoc = await db().collection('users').doc(req.user!.uid).get();
    const sender    = senderDoc.data();

    const orderId = `LL_${shipmentId}_${Date.now()}`;
    const payload = {
      order_id:       orderId,
      order_amount:   (ship.totalAmount / 100).toFixed(2),
      order_currency: 'INR',
      order_note:     `PeerDrop: ${ship.from} → ${ship.to}`,
      customer_details: {
        customer_id:    req.user!.uid,
        customer_name:  sender?.fullName  || 'Sender',
        customer_email: sender?.email     || req.user!.email || '',
        customer_phone: sender?.phone     || '9999999999',
      },
    };

    const response = await axios.post(
      `${cashfreeBase()}/orders`,
      payload,
      { headers: cashfreeHeaders() }
    );

    const { order_id, payment_session_id } = response.data;
    await doc.ref.update({ cashfreeOrderId: order_id });

    return res.json({
      orderId:          order_id,
      paymentSessionId: payment_session_id,
      amount:           ship.totalAmount / 100,
      currency:         'INR',
      mock:             false,
    });
  } catch (err: any) {
    const msg = err.response?.data?.message || err.message;
    return res.status(500).json({ error: msg });
  }
});

// ── POST /api/payments/verify ─────────────────────────────────────────────────
router.post('/verify', verifyToken, async (req: AuthRequest, res: Response) => {
  const { orderId, shipmentId } = req.body;
  if (!orderId || !shipmentId)
    return res.status(400).json({ error: 'orderId and shipmentId are required' });

  const isMock = orderId.startsWith('mock_');

  if (!isMock) {
    try {
      // Verify with Cashfree
      const response = await axios.get(
        `${cashfreeBase()}/orders/${orderId}/payments`,
        { headers: cashfreeHeaders() }
      );
      const payments = response.data;
      const success  = Array.isArray(payments)
        ? payments.some((p: any) => p.payment_status === 'SUCCESS')
        : false;
      if (!success) return res.status(400).json({ error: 'Payment not successful yet' });
    } catch (err: any) {
      return res.status(400).json({ error: 'Payment verification failed' });
    }
  }

  try {
    await db().collection('shipments').doc(shipmentId).update({
      paymentStatus:     'paid',
      cashfreeOrderId:   orderId,
      paidAt:            new Date().toISOString(),
    });
    return res.json({ message: 'Payment verified successfully' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/payments/withdraw ───────────────────────────────────────────────
router.post('/withdraw', verifyToken, async (req: AuthRequest, res: Response) => {
  if (req.user?.role !== 'traveller')
    return res.status(403).json({ error: 'Only travellers can withdraw' });

  const { amount } = req.body;
  if (!amount || Number(amount) <= 0)
    return res.status(400).json({ error: 'Valid amount in paise is required' });

  try {
    const userRef = db().collection('users').doc(req.user!.uid);
    await db().runTransaction(async (t) => {
      const doc     = await t.get(userRef);
      const balance = doc.data()?.walletBalance || 0;
      if (Number(amount) > balance) throw new Error('Insufficient wallet balance');
      t.update(userRef, { walletBalance: balance - Number(amount) });
      const wRef = db().collection('withdrawals').doc();
      t.set(wRef, {
        id:           wRef.id,
        travellerId:  req.user!.uid,
        amount:       Number(amount),
        status:       'processing',
        requestedAt:  new Date().toISOString(),
      });
    });
    return res.json({ message: 'Withdrawal request submitted. Processed within 24 hours.' });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// ── GET /api/payments/wallet ──────────────────────────────────────────────────
router.get('/wallet', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const doc     = await db().collection('users').doc(req.user!.uid).get();
    const balance = doc.data()?.walletBalance || 0;
    return res.json({
      walletBalance:          balance,
      walletBalanceFormatted: `₹${(balance / 100).toFixed(2)}`,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
