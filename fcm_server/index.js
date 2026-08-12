const express = require('express');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

// Note: For local testing, we assume serviceAccountKey.json is in this folder.
// In Render, we'll parse it from an environment variable.
let serviceAccount;
try {
  serviceAccount = require('./serviceAccountKey.json');
} catch (e) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    console.error("No serviceAccountKey.json or FIREBASE_SERVICE_ACCOUNT found!");
    process.exit(1);
  }
}

if (!getApps().length) {
  initializeApp({
    credential: cert(serviceAccount),
  });
}

const db = getFirestore();
const app = express();
const PORT = process.env.PORT || 3000;

// State tracking so we don't spam notifications for the same event
// childId -> { lastNotifiedState: 'online' | 'offline', uninstalledNotified: boolean }
const deviceStateCache = new Map();

// Helper to send FCM to Parent
async function notifyParent(parentUid, title, body) {
  try {
    const parentDoc = await db.collection('parents').doc(parentUid).get();
    if (!parentDoc.exists) return;
    
    const parentFcmToken = parentDoc.data().fcmToken;
    if (!parentFcmToken) {
      console.log(`[SKIP] Parent ${parentUid} has no FCM token saved.`);
      return;
    }

    const response = await getMessaging().send({
      token: parentFcmToken,
      notification: {
        title: title,
        body: body,
      },
      android: {
        priority: 'high',
      }
    });
    console.log(`[SENT] to ${parentUid}: ${title} - ${response}`);
  } catch (error) {
    console.error(`[ERROR] Failed to notify parent ${parentUid}:`, error.message);
  }
}

// Set up the listener on all children
// We use a collectionGroup query to listen to ALL 'children' collections across all parents
function startFirestoreListener() {
  console.log("Starting real-time Firestore listener for Child updates...");
  
  db.collectionGroup('children').onSnapshot(snapshot => {
    snapshot.docChanges().forEach(change => {
      if (change.type === 'added' || change.type === 'modified') {
        const childDoc = change.doc;
        const data = childDoc.data();
        const childId = childDoc.id;
        const parentUid = childDoc.ref.parent.parent.id; // parents/{parentUid}/children/{childId}
        const model = data.deviceModel || data.deviceName || "Unknown Device";
        
        // 1. Check for Uninstalled
        const appUninstalled = data.appUninstalled === true;
        let cache = deviceStateCache.get(childId) || { lastNotifiedState: 'offline', uninstalledNotified: false };
        
        if (appUninstalled && !cache.uninstalledNotified) {
          console.log(`[EVENT] ${model} was UNINSTALLED!`);
          notifyParent(parentUid, "⚠️ App Uninstalled", `ALERT: Child Companion has been UNINSTALLED from ${model}!`);
          cache.uninstalledNotified = true;
          deviceStateCache.set(childId, cache);
          return; // Skip online check if uninstalled
        }

        // 2. Check for Online (lastSeen updated within last 2 minutes)
        if (data.lastSeen) {
          const lastSeenDate = data.lastSeen.toDate();
          const now = new Date();
          const diffSeconds = (now - lastSeenDate) / 1000;
          
          if (diffSeconds < 120) {
            // It's online now
            if (cache.lastNotifiedState !== 'online') {
              console.log(`[EVENT] ${model} is ONLINE!`);
              notifyParent(parentUid, "🟢 Device Online", `${model} is now ONLINE and sending data!`);
              cache.lastNotifiedState = 'online';
              deviceStateCache.set(childId, cache);
            }
          } else if (diffSeconds > 600) {
            // It's offline (no updates for 10+ mins)
            if (cache.lastNotifiedState !== 'offline') {
              cache.lastNotifiedState = 'offline';
              deviceStateCache.set(childId, cache);
            }
          }
        }
      }
    });
  }, error => {
    console.error("Firestore listen error:", error);
  });
}

// Listen to all 'commands' subcollections to instantly wake up the child
function startCommandsListener() {
  console.log("Starting real-time Firestore listener for pending Commands...");
  
  db.collectionGroup('commands').onSnapshot(async snapshot => {
    snapshot.docChanges().forEach(async change => {
      if (change.type === 'added') {
        const cmdDoc = change.doc;
        const cmdData = cmdDoc.data();
        
        // Filter in memory to avoid Firestore Index requirement
        if (cmdData.status !== 'pending') return;
        
        const childRef = cmdDoc.ref.parent.parent; // parents/{parentUid}/children/{childId}
        if (!childRef) return;
        
        try {
          const childSnap = await childRef.get();
          if (childSnap.exists && childSnap.data().fcmToken) {
            console.log(`[WAKE UP] Sending silent ping to ${childRef.id} for command ${cmdData.command}`);
            await getMessaging().send({
              token: childSnap.data().fcmToken,
              data: {
                wakeup: "true",
                reason: "new_command"
              },
              android: {
                priority: "high"
              }
            });
          }
        } catch (e) {
          console.error(`[ERROR] Failed to wake child ${childRef.id}:`, e.message);
        }
      }
    });
  }, error => {
    console.error("Commands listen error:", error);
  });
}

const nodemailer = require('nodemailer');

// Admin UID and Email for alerts
const ADMIN_PARENT_UID = process.env.ADMIN_PARENT_UID || 'wWnAwJ0MPsfeU6eXbMHeQNjSuWy1';
const ALERT_EMAIL = process.env.ALERT_EMAIL || 'pandityesh45@gmail.com';

// Setup email transporter if SMTP credentials exist
let mailTransporter = null;
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

// Track known parent accounts to avoid alerting on initial server boot load
const knownParents = new Set();
let isInitialParentLoad = true;

// Helper to send Email Alert to Admin
async function sendAdminEmail(subject, text) {
  if (!mailTransporter) {
    console.log(`[MAIL SKIP] SMTP_USER / SMTP_PASS environment variables not set. Subject: ${subject}`);
    return;
  }
  try {
    await mailTransporter.sendMail({
      from: `"ParentGuard Security Alert" <${process.env.SMTP_USER}>`,
      to: ALERT_EMAIL,
      subject: subject,
      text: text,
    });
    console.log(`[MAIL SENT] Email successfully sent to ${ALERT_EMAIL}`);
  } catch (err) {
    console.error(`[MAIL ERROR] Failed to send email alert:`, err.message);
  }
}

// Listen to all new 'parents' registrations in Firestore
function startNewAccountListener() {
  console.log("Starting real-time Firestore listener for New Parent Registrations...");

  db.collection('parents').onSnapshot(snapshot => {
    if (isInitialParentLoad) {
      snapshot.docs.forEach(doc => knownParents.add(doc.id));
      isInitialParentLoad = false;
      console.log(`[INIT] Loaded ${knownParents.size} existing parent accounts.`);
      return;
    }

    snapshot.docChanges().forEach(async change => {
      if (change.type === 'added' && !knownParents.has(change.doc.id)) {
        const parentDoc = change.doc;
        const parentData = parentDoc.data();
        const parentId = parentDoc.id;
        const parentEmail = parentData.email || 'No email provided';
        const createdAt = parentData.createdAt ? parentData.createdAt.toDate().toLocaleString() : new Date().toLocaleString();

        knownParents.add(parentId);
        console.log(`[EVENT] 🆕 New Parent Account Created! Email: ${parentEmail} (UID: ${parentId})`);

        const alertMessage = `ALERT: A new Parent Account was just created!\n\nEmail: ${parentEmail}\nUser ID: ${parentId}\nTime: ${createdAt}`;

        // 1. Send High-Priority FCM Push Notification to Admin's phone
        notifyParent(ADMIN_PARENT_UID, "🆕 New Parent Account!", `New account registered: ${parentEmail}`);

        // 2. Send Email alert to Admin Gmail
        sendAdminEmail("🚨 Alert: New Parent Account Registered!", alertMessage);
      }
    });
  }, error => {
    console.error("Parents listen error:", error);
  });
}

// Start the Express web server (required by Render)
app.get('/', (req, res) => {
  res.send('Child Companion FCM Listener Server is RUNNING 🟢');
});

app.listen(PORT, () => {
  console.log(`FCM Listener Web Server is listening on port ${PORT}`);
  startFirestoreListener();
  startCommandsListener();
  startNewAccountListener();
});
