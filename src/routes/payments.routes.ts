import { Router, Response } from 'express';
import { db } from '../config/firebase';
import { verifyToken, AuthRequest } from '../middleware/verifyToken';

const router = Router();

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

    // Generate a local order ID — used to track this payment attempt
    const orderId = `LL_${shipmentId.slice(-8)}_${Date.now()}`;
    await doc.ref.update({ pendingOrderId: orderId });

    return res.json({
      orderId,
      amount:   ship.totalAmount,        // paise
      amountRs: (ship.totalAmount / 100).toFixed(2),
      currency: 'INR',
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/payments/verify ─────────────────────────────────────────────────
// Called when sender taps "I Have Paid" — marks shipment as paid
router.post('/verify', verifyToken, async (req: AuthRequest, res: Response) => {
  const { orderId, shipmentId } = req.body;
  if (!orderId || !shipmentId)
    return res.status(400).json({ error: 'orderId and shipmentId are required' });

  try {
    const doc  = await db().collection('shipments').doc(shipmentId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Shipment not found' });
    const ship = doc.data()!;
    if (ship.senderId !== req.user!.uid) return res.status(403).json({ error: 'Not your shipment' });
    if (ship.paymentStatus === 'paid')   return res.json({ message: 'Already paid' });

    await doc.ref.update({
      paymentStatus: 'paid',
      orderId:       orderId,
      paidAt:        new Date().toISOString(),
    });
    return res.json({ message: 'Payment confirmed. Traveller notified.' });
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
