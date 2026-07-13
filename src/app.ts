import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import compression from 'compression';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

import authRouter from './routes/auth.routes';
import tripsRouter from './routes/trips.routes';
import shipmentsRouter from './routes/shipments.routes';
import paymentsRouter from './routes/payments.routes';

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(compression());
app.use(morgan('dev'));

// API routes
app.use('/api/auth', authRouter);
app.use('/api/trips', tripsRouter);
app.use('/api/shipments', shipmentsRouter);
app.use('/api/payments', paymentsRouter);

// Razorpay webhook needs raw body for signature verification
// (express.json() is already applied above, which is fine for our HMAC approach)

// Health check
app.get('/api/health', (_req, res) => res.json({ status: 'ok', app: 'LoadLink' }));

// Serve frontend static files
app.use(express.static(path.join(__dirname, '../public/app')));

// All non-API routes serve the SPA
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/app/index.html'));
});

export default app;
