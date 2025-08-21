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
  startAfter,
  limit,
  doc,
  setDoc,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const db = getFirestore(app);
const auth = getAuth(app);

let currentUserId = null;
let roomId = null;
const PAGE_SIZE = 20;

const messagesContainer = document.getElementById("messagesContainer");
const inputField = document.getElementById("messageInput");
const sendButton = document.getElementById("sendBtn");
const typingIndicator = document.getElementById("typingIndicator");
const newMessagesBtn = document.getElementById("newMessagesBtn");
const searchInput = document.getElementById("searchInput");
const searchResults = document.getElementById("searchResults");
const offlineBanner = document.getElementById("offlineBanner");

let lastVisibleMsg = null;
let isFetching = false;
let renderedMessages = new Map();
let renderedDateSet = new Set();
let isSending = false;
let typingTimeout = null;
let hasUserScrolledAway = false;

// Authentication and Initialization
signInAnonymously(auth).catch(console.error);

onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUserId = user.uid;

    // Parse roomId from URL
    roomId = new URLSearchParams(window.location.search).get("roomId");
    if (!roomId) {
      alert("Room ID missing in URL");
      return;
    }

    updateSendButtonState();
    monitorNetworkStatus();

    await fetchMessages();
    watchNewMessages();
    listenForTypingStatus();
    setupEventListeners();

    updateLastRead();
    scrollToBottom();
  }
});

// Fetch paginated messages (older messages)
async function fetchMessages() {
  if (isFetching) return;
  isFetching = true;

  const messagesRef = collection(db, "chatrooms", roomId, "messages");
  let q;

  if (!lastVisibleMsg) {
    q = query(messagesRef, orderBy("createdAt", "asc"), limit(PAGE_SIZE));
  } else {
    q = query(messagesRef, orderBy("createdAt", "asc"), startAfter(lastVisibleMsg), limit(PAGE_SIZE));
  }

  const snapshot = await q.get ? await q.get() : await getDocs(q);
  if (snapshot.empty) {
    isFetching = false;
    return;
  }

  let messages = [];
  snapshot.forEach((docSnap) => {
    const data = docSnap.data();
    messages.push({ ...data, id: docSnap.id, createdAt: data.createdAt?.toDate() });
  });

  lastVisibleMsg = snapshot.docs ? snapshot.docs[snapshot.docs.length - 1] : null;

  prependMessages(messages);
  isFetching = false;
}

// Prepend messages at top (pagination)
function prependMessages(messages) {
  messages.forEach((msg) => {
    if (renderedMessages.has(msg.id)) return;

    if (msg.createdAt) addDateSeparatorIfNeeded(msg.createdAt, true);

    const isMe = msg.senderId === currentUserId;
    const messageDiv = createMessageDiv(msg, isMe);
    messagesContainer.insertBefore(messageDiv, messagesContainer.firstChild);
    renderedMessages.set(msg.id, messageDiv);
  });
}

// Create message element
function createMessageDiv(msg, isMe) {
  const div = document.createElement("div");
  div.classList.add("message");
  div.classList.add(isMe ? "message-sent" : "message-received");
  div.setAttribute("data-id", msg.id);

  const timeText = msg.createdAt
    ? msg.createdAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";

  div.innerHTML = `
    <strong class="username">${isMe ? "Me" : msg.senderId}</strong>
    <p>${escapeHtml(msg.text || "")}</p>
    <span class="timestamp">${timeText}</span>
  `;
  return div;
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  if (!text) return "";
  return text.replace(/[&<>"']/g, (match) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[match];
  });
}

// Real-time listener for new messages
function watchNewMessages() {
  const messagesRef = collection(db, "chatrooms", roomId, "messages");
  const q = query(messagesRef, orderBy("createdAt", "asc"));

  onSnapshot(q, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === "added") {
        const msg = change.doc.data();
        msg.id = change.doc.id;
        msg.createdAt = msg.createdAt?.toDate();

        if (renderedMessages.has(msg.id)) return;
        if (msg.createdAt) addDateSeparatorIfNeeded(msg.createdAt, false);

        const isMe = msg.senderId === currentUserId;
        const messageDiv = createMessageDiv(msg, isMe);
        messagesContainer.appendChild(messageDiv);
        renderedMessages.set(msg.id, messageDiv);

        if (isScrolledToBottom() || isMe) {
          scrollToBottom();
          newMessagesBtn.style.display = "none";
        } else {
          newMessagesBtn.style.display = "block";
        }
      }
    });
  });
}

// Date separator helpers
function addDateSeparatorIfNeeded(date, prepend) {
  const dateKey = date.toDateString();
  if (!renderedDateSet.has(dateKey)) {
    const separator = document.createElement("div");
    separator.classList.add("date-separator");
    separator.setAttribute("data-date", dateKey);
    separator.textContent = formatDateLabel(date);

    if (prepend) {
      messagesContainer.insertBefore(separator, messagesContainer.firstChild);
    } else {
      messagesContainer.appendChild(separator);
    }
    renderedDateSet.add(dateKey);
  }
}

function formatDateLabel(date) {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString();
}

// Event listeners setup
function setupEventListeners() {
  sendButton.addEventListener("click", sendMessage);
  inputField.addEventListener("input", onInputChange);
  inputField.addEventListener("keypress", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  messagesContainer.addEventListener("scroll", onScroll);
  newMessagesBtn.addEventListener("click", () => {
    scrollToBottom();
    newMessagesBtn.style.display = "none";
  });
  searchInput.addEventListener("input", searchMessages);
}

// Handle input changes (enable send button, typing)
function onInputChange() {
  updateSendButtonState();
  sendTypingStatus(true);
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => sendTypingStatus(false), 2000);
}

// Send chat message
async function sendMessage() {
  const text = inputField.value.trim();
  if (!text || isSending) return;

  isSending = true;
  updateSendButtonState();

  try {
    await addDoc(collection(db, "chatrooms", roomId, "messages"), {
      text,
      senderId: currentUserId,
      createdAt: serverTimestamp(),
    });
    inputField.value = "";
  } catch (err) {
    alert("Error sending message.");
    console.error(err);
  } finally {
    isSending = false;
    updateSendButtonState();
    sendTypingStatus(false);
  }
}

// Typing indicator management
let typingRef = null;
async function sendTypingStatus(isTyping) {
  if (!currentUserId || !roomId) return;

  if (!typingRef) typingRef = doc(db, "typing", roomId, "users", currentUserId);


  try {
    await setDoc(
      typingRef,
      {
        isTyping,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  } catch (e) {
    console.error("Sending typing status failed:", e);
  }
}

function listenForTypingStatus() {
  const typingCollection = collection(db, "typing", roomId, "users")

  onSnapshot(typingCollection, (snapshot) => {
    const typingUsers = [];
    snapshot.forEach((docSnap) => {
      if (
        docSnap.id !== currentUserId &&
        docSnap.data().isTyping
      ) {
        typingUsers.push(docSnap.id);
      }
    });

    if (typingUsers.length > 0) {
      typingIndicator.style.display = "block";
      typingIndicator.textContent =
        typingUsers.length === 1
          ? `${typingUsers[0]} is typing...`
          : `${typingUsers.join(", ")} are typing...`;
    } else {
      typingIndicator.style.display = "none";
    }
  });
}

// Update read timestamp on chat open or scroll bottom
async function updateLastRead() {
  if (!currentUserId || !roomId) return;

  const readRef = doc(db, "reads", `${currentUserId}_${roomId}`);
  try {
    await setDoc(
      readRef,
      { lastReadTimestamp: serverTimestamp() },
      { merge: true }
    );
  } catch (e) {
    console.error("Failed to update last read timestamp", e);
  }
}

// UI helpers
function updateSendButtonState() {
  const text = inputField.value.trim();
  sendButton.disabled = !text || text.length > 300 || isSending;
}

function isScrolledToBottom() {
  return (
    messagesContainer.scrollHeight - messagesContainer.scrollTop <=
    messagesContainer.clientHeight + 10
  );
}

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Infinite scroll for pagination
async function onScroll() {
  if (messagesContainer.scrollTop === 0) {
    await fetchMessages();
  }
  if (isScrolledToBottom()) {
    newMessagesBtn.style.display = "none";
    updateLastRead();
  }
}

// Basic search over rendered messages (client-side)
function searchMessages() {
  const queryText = searchInput.value.toLowerCase();
  searchResults.innerHTML = "";
  if (!queryText) {
    searchResults.style.display = "none";
    return;
  }

  const matched = [];
  renderedMessages.forEach((msgDiv) => {
    const text = msgDiv.querySelector("p")?.textContent.toLowerCase() || "";
    if (text.includes(queryText)) matched.push(msgDiv);
  });

  if (matched.length === 0) {
    searchResults.style.display = "none";
    return;
  }

  matched.forEach((msgDiv) => {
    const item = document.createElement("div");
    item.className = "search-result-item";
    item.textContent = msgDiv.querySelector("p").textContent;
    item.onclick = () => {
      msgDiv.scrollIntoView({ behavior: "smooth", block: "center" });
      searchResults.style.display = "none";
      searchInput.value = "";
    };
    searchResults.appendChild(item);
  });

  searchResults.style.display = "block";
}

// Network status offline banner
function monitorNetworkStatus() {
  if (!offlineBanner) return;
  offlineBanner.style.display = navigator.onLine ? "none" : "block";
  window.addEventListener("online", () => {
    offlineBanner.style.display = "none";
  });
  window.addEventListener("offline", () => {
    offlineBanner.style.display = "block";
  });
}
