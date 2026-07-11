import * as dotenv from 'dotenv';
dotenv.config();

import { initializeApp, getApps, cert, App } from 'firebase-admin/app';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import { getAuth, Auth } from 'firebase-admin/auth';

let _app: App | null = null;
let _db: Firestore | null = null;
let _auth: Auth | null = null;

function getApp(): App {
  if (_app) return _app;

  const projectId   = process.env.FIREBASE_PROJECT_ID?.trim();
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  let privateKey    = process.env.FIREBASE_PRIVATE_KEY;

  // Handle both formats: with \n escape sequences and with real newlines
  if (privateKey) {
    privateKey = privateKey.replace(/\\n/g, '\n').replace(/^"|"$/g, '');
  }

  if (!projectId || !clientEmail || !privateKey ||
      privateKey.includes('YOUR_PRIVATE_KEY')) {
    throw new Error(
      '⚠️  Firebase credentials not set.\n' +
      '   Open .env and fill in:\n' +
      '   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY\n' +
      '   Get them from Firebase Console → Project Settings → Service Accounts → Generate new private key'
    );
  }

  if (getApps().length) {
    _app = getApps()[0];
  } else {
    _app = initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  }
  return _app;
}

export function db(): Firestore {
  if (!_db) _db = getFirestore(getApp());
  return _db;
}

export function auth(): Auth {
  if (!_auth) _auth = getAuth(getApp());
  return _auth;
}
