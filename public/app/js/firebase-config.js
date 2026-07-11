import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyC52qAzd-VPKCWHlgwPXcjbAiHzQNR3JiU",
  authDomain: "loadlink-359f8.firebaseapp.com",
  projectId: "loadlink-359f8",
  storageBucket: "loadlink-359f8.firebasestorage.app",
  messagingSenderId: "858979714027",
  appId: "1:858979714027:web:d65054255c873b4046cfae"
};

const firebaseApp  = initializeApp(FIREBASE_CONFIG);
const firebaseAuth = getAuth(firebaseApp);

export {
  firebaseApp,
  firebaseAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged
};
