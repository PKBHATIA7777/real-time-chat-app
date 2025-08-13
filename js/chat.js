// js/chat.js
import { app } from "./firebase-config.js";
import {
  getFirestore,
  collection,
  addDoc,
  onSnapshot,
  serverTimestamp,
  query,
  orderBy,
  doc,
  setDoc,
  updateDoc,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

// --- Utility functions ---
function isToday(date) {
  const today = new Date();
  return date.toDateString() === today.toDateString();
}
function isYesterday(date) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return date.toDateString() === yesterday.toDateString();
}

const db = getFirestore(app);
const auth = getAuth(app);

let currentUserId = null;
let typingTimeout = null;
let renderedMessages = {}; // Cache for rendered message DOM elements

// DOM elements
const messagesContainer = document.querySelector("#messagesContainer");
const inputField = document.querySelector("#messageInput");
const sendButton = document.querySelector("#sendBtn");
const typingIndicator = document.querySelector("#typingIndicator");
const newMessagesBtn = document.querySelector("#newMessagesBtn");

sendButton.disabled = true;

// --- Sign in ---
signInAnonymously(auth).catch((err) => console.error("Auth error:", err));

onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUserId = user.uid;
    console.log("✅ Logged in as:", currentUserId);

    await setDoc(doc(db, "users", currentUserId), {
      name: `User-${currentUserId.slice(0, 4)}`,
      typing: false
    }, { merge: true });

    sendButton.disabled = false;
    listenForMessages();
    listenForTyping();
  }
});

// --- Listen for messages (Optimized + Dynamic ticks) ---
function listenForMessages() {
  const messagesRef = collection(db, "messages");
  const q = query(messagesRef, orderBy("createdAt"));

  onSnapshot(q, async (snapshot) => {
    for (const change of snapshot.docChanges()) {
      const docSnap = change.doc;
      const data = docSnap.data();
      const createdAtDate = data.createdAt?.toDate ? data.createdAt.toDate() : null;
      const isMe = data.sentBy === currentUserId;

      // Mark as delivered if the message is for me
      if (!isMe && !data.delivered) {
        await updateDoc(doc(db, "messages", docSnap.id), { delivered: true });
      }

      // Mark as read if the message is visible and for me
      if (!isMe && !data.readBy?.[currentUserId]) {
        await updateDoc(doc(db, "messages", docSnap.id), {
          [`readBy.${currentUserId}`]: serverTimestamp()
        });
      }

      // Fetch username
      let username = "Unknown";
      if (data.sentBy) {
        const userDoc = await getDoc(doc(db, "users", data.sentBy));
        if (userDoc.exists()) {
          username = userDoc.data().name || "Unknown";
        }
      }

      // Date separator
      const dateKey = createdAtDate ? createdAtDate.toDateString() : null;
      if (dateKey && !document.querySelector(`[data-date="${dateKey}"]`)) {
        const dateSeparator = document.createElement("div");
        dateSeparator.classList.add("date-separator");
        dateSeparator.setAttribute("data-date", dateKey);
        dateSeparator.textContent = isToday(createdAtDate)
          ? "Today"
          : isYesterday(createdAtDate)
          ? "Yesterday"
          : createdAtDate.toLocaleDateString();
        messagesContainer.appendChild(dateSeparator);
      }

      // Create / update message DOM
      if (change.type === "added" || change.type === "modified") {
        let messageDiv = renderedMessages[docSnap.id];
        if (!messageDiv) {
          messageDiv = document.createElement("div");
          messageDiv.classList.add("message", isMe ? "message-sent" : "message-received");
          messageDiv.setAttribute("data-id", docSnap.id);
          renderedMessages[docSnap.id] = messageDiv;
          messagesContainer.appendChild(messageDiv);
        }

        let timeText = createdAtDate
          ? createdAtDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : "";

        // WhatsApp ticks
        let ticks = "";
        if (isMe) {
          if (data.readBy && Object.keys(data.readBy).length > 1) {
            ticks = `<span class="tick read">✓✓</span>`;
          } else if (data.delivered) {
            ticks = `<span class="tick delivered">✓✓</span>`;
          } else {
            ticks = `<span class="tick sent">✓</span>`;
          }
        }

        messageDiv.innerHTML = `
          <strong class="username">${username}</strong>
          <p>${data.text || ""}</p>
          <span class="timestamp">${timeText} ${ticks}</span>
        `;
      }
    }

    // Scroll behavior
    if (isScrolledToBottom()) {
      scrollToBottom();
      newMessagesBtn.style.display = "none";
    } else {
      newMessagesBtn.style.display = "block";
    }
  });
}

// --- Listen for typing ---
function listenForTyping() {
  const usersRef = collection(db, "users");
  onSnapshot(usersRef, (snapshot) => {
    let typingUsers = [];
    snapshot.forEach((doc) => {
      const user = doc.data();
      if (user.typing && doc.id !== currentUserId) {
        typingUsers.push(user.name || "Unknown");
      }
    });

    if (typingUsers.length > 0) {
      typingIndicator.textContent =
        typingUsers.length === 1
          ? `${typingUsers[0]} is typing...`
          : `${typingUsers.join(", ")} are typing...`;
      typingIndicator.style.display = "block";
    } else {
      typingIndicator.style.display = "none";
    }
  });
}

// --- Send message ---
async function sendMessage() {
  const text = inputField.value.trim();
  if (!text) return;

  if (!currentUserId) {
    alert("User not authenticated yet!");
    return;
  }

  try {
    await addDoc(collection(db, "messages"), {
      text,
      sentBy: currentUserId,
      createdAt: serverTimestamp(),
      delivered: false,
      readBy: {}
    });

    await updateDoc(doc(db, "users", currentUserId), { typing: false });
    inputField.value = "";
  } catch (error) {
    console.error("Error sending message:", error);
  }
}

// --- Typing event ---
inputField.addEventListener("input", async () => {
  if (!currentUserId) return;
  await updateDoc(doc(db, "users", currentUserId), { typing: true });

  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(async () => {
    await updateDoc(doc(db, "users", currentUserId), { typing: false });
  }, 1500);
});

// --- Scroll helpers ---
function isScrolledToBottom() {
  return messagesContainer.scrollHeight - messagesContainer.scrollTop <= messagesContainer.clientHeight + 10;
}
function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// --- New messages button ---
messagesContainer.addEventListener("scroll", () => {
  if (isScrolledToBottom()) {
    newMessagesBtn.style.display = "none";
  }
});
newMessagesBtn.addEventListener("click", () => {
  scrollToBottom();
  newMessagesBtn.style.display = "none";
});

// --- Send on click / enter ---
sendButton.addEventListener("click", sendMessage);
inputField.addEventListener("keypress", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
