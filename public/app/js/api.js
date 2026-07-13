// Central API helper — all calls go through here
const BASE = '/api';

// Import Firebase auth to get fresh tokens
import { firebaseAuth } from './firebase-config.js';

/**
 * Wait for Firebase Auth to finish restoring the session.
 * Returns the current user (or null if not logged in).
 */
function waitForAuthReady() {
  return new Promise((resolve) => {
    // If already resolved, return immediately
    if (firebaseAuth.currentUser !== undefined) {
      // currentUser can be null (not logged in) or a User object
      resolve(firebaseAuth.currentUser);
      return;
    }
    // Otherwise wait for the first auth state change
    const unsubscribe = firebaseAuth.onAuthStateChanged((user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

async function getFreshToken() {
  // Always wait for auth to be ready first
  const user = firebaseAuth.currentUser || await waitForAuthReady();
  if (user) {
    // Only force-refresh if token is close to expiry (every ~50 min)
    // Passing false = use cached token if still valid (avoids race conditions)
    const token = await user.getIdToken(false);
    localStorage.setItem('ll_token', token);
    return token;
  }
  return localStorage.getItem('ll_token');
}

export async function apiCall(method, path, body = null) {
  const token = await getFreshToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(BASE + path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export const api = {
  // Auth
  register: (body) => apiCall('POST', '/auth/register', body),
  getMe:    ()     => apiCall('GET',  '/auth/me'),

  // Trips
  postTrip:    (body) => apiCall('POST',  '/trips', body),
  getTrips:    (q='') => apiCall('GET',   `/trips${q}`),
  getMyTrips:  ()     => apiCall('GET',   '/trips/my'),
  getTrip:     (id)   => apiCall('GET',   `/trips/${id}`),
  closeTrip:   (id)   => apiCall('PATCH', `/trips/${id}/close`),

  // Shipments
  requestShipment:  (body) => apiCall('POST',  '/shipments', body),
  getMyShipments:   ()     => apiCall('GET',   '/shipments/my'),
  getShipment:      (id)   => apiCall('GET',   `/shipments/${id}`),
  respondShipment:  (id, action) => apiCall('PATCH', `/shipments/${id}/respond`, { action }),
  updateStatus:     (id, status) => apiCall('PATCH', `/shipments/${id}/status`,  { status }),
  markPickup:       (id)   => apiCall('PATCH', `/shipments/${id}/mark-pickup`),
  uploadDeliveryPhoto: (id, photoBase64, mimeType) =>
    apiCall('POST', `/shipments/${id}/upload-delivery-photo`, { photoBase64, mimeType }),
  confirmDelivery:  (id)   => apiCall('POST',  `/shipments/${id}/confirm-delivery`),

  // Payments (Mock — swap in real gateway keys later)
  createOrder:    (shipmentId) => apiCall('POST', '/payments/create-order', { shipmentId }),
  simulatePay:    (body)       => apiCall('POST', '/payments/simulate-pay', body),
  withdraw:       (amount)     => apiCall('POST', '/payments/withdraw', { amount }),
  getWallet:      ()           => apiCall('GET',  '/payments/wallet'),
};

export function getUser() {
  const u = localStorage.getItem('ll_user');
  return u ? JSON.parse(u) : null;
}

export function getToken() {
  return localStorage.getItem('ll_token');
}

export function logout() {
  localStorage.removeItem('ll_token');
  localStorage.removeItem('ll_user');
  window.location.href = '/login.html';
}

export function requireAuth(role = null) {
  const user = getUser();
  const token = getToken();
  if (!token || !user) { window.location.href = '/login.html'; return null; }
  if (role && user.role !== role) { window.location.href = '/dashboard.html'; return null; }
  return user;
}

export function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function formatAmount(paise) {
  return `₹${(paise / 100).toFixed(2)}`;
}
