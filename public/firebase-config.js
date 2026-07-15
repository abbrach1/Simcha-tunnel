// Firebase project used for live sync when the host can't run the Node
// server (e.g. static hosting / Vercel without the Redis integration).
// Set to null to disable Firebase mode entirely.
//
// This web config is a public identifier, not a secret — access control
// comes from your Firestore security rules (see README).
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyCEcuofS1p-wB_8_bpQkv4HgPXq_LdSi3s",
  authDomain: "tc-call.firebaseapp.com",
  projectId: "tc-call",
  storageBucket: "tc-call.firebasestorage.app",
  messagingSenderId: "1076247683093",
  appId: "1:1076247683093:web:014add88b942269b9b2e1c",
};
