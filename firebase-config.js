// Firebase 초기화 (project: eval-cfb93)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyClkp1ETLEVe3B2wSGeqpbAOYYyPkoh2Pc",
  authDomain: "eval-cfb93.firebaseapp.com",
  projectId: "eval-cfb93",
  storageBucket: "eval-cfb93.firebasestorage.app",
  messagingSenderId: "672496942874",
  appId: "1:672496942874:web:d3619c83f73f25ff5036a3",
  measurementId: "G-G3DR4GNX7Y"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
