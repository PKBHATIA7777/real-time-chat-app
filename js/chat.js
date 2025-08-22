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
  getDoc,
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
const chatTitleElem = document.querySelector(".chat-title");
const backBtn = document.getElementById("backBtn");

let lastVisibleMsg = null;
let isFetching = false;
let renderedMessages = new Map();
let renderedDateSet = new Set();
let isSending = false;
let typingTimeout = null;

// Helper: Get date string in YYYY-MM-DD
function dateString(date) {
  return date.toISOString().substring(0, 10);
}

function formatDateLabel(date) {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString();
}

function insertDateSeparator(date, prepend, refNode = null) {
  const dateKey = dateString(date);
  if (renderedDateSet.has(dateKey)) return;

  const separator = document.createElement("div");
  separator.classList.add("date-separator");
  separator.setAttribute("data-date", dateKey);
  separator.textContent = formatDateLabel(date);

  if (prepend && refNode) {
    messagesContainer.insertBefore(separator, refNode);
  } else {
    messagesContainer.appendChild(separator);
  }
  renderedDateSet.add(dateKey);
}

// Authentication and Initialization
signInAnonymously(auth).catch(console.error);

onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUserId = user.uid;

    roomId = new URLSearchParams(window.location.search).get("roomId");
    if (!roomId) {
      alert("Room ID missing in URL");
      return;
    }

    if (chatTitleElem) {
      const roomDoc = await getDoc(doc(db, "chatrooms", roomId));
      chatTitleElem.textContent = roomDoc.exists() ? roomDoc.data().title || "Unnamed Room" : "Room Not Found";
    }

    renderedDateSet = new Set();

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

// Fetch paginated older messages (prepend)
async function fetchMessages() {
  if (isFetching) return;
  isFetching = true;

  const messagesRef = collection(db, "chatrooms", roomId, "messages");
  let q = !lastVisibleMsg
    ? query(messagesRef, orderBy("createdAt", "asc"), limit(PAGE_SIZE))
    : query(messagesRef, orderBy("createdAt", "asc"), startAfter(lastVisibleMsg), limit(PAGE_SIZE));

  const snapshot = await getDocs(q);
  if (snapshot.empty) {
    isFetching = false;
    return;
  }

  let messages = [];
  snapshot.forEach((docSnap) => {
    const data = docSnap.data();
    messages.push({ ...data, id: docSnap.id, createdAt: data.createdAt?.toDate() });
  });

  lastVisibleMsg = snapshot.docs[snapshot.docs.length - 1];
  prependMessages(messages);
  isFetching = false;
}

function prependMessages(messages) {
  // reverse to render oldest first
  messages.reverse();
  let prevDateStr = null;

  messages.forEach((msg) => {
    if (renderedMessages.has(msg.id) || !msg.createdAt) return;

    let msgDateStr = dateString(msg.createdAt);
    if (prevDateStr !== msgDateStr) {
      insertDateSeparator(msg.createdAt, true, messagesContainer.firstChild);
    }

    const isMe = msg.senderId === currentUserId;
    const messageDiv = createMessageDiv(msg, isMe);
    messagesContainer.insertBefore(messageDiv, messagesContainer.firstChild);
    renderedMessages.set(msg.id, messageDiv);

    prevDateStr = msgDateStr;
  });
}

function createMessageDiv(msg, isMe) {
  const div = document.createElement("div");
  div.classList.add("message", isMe ? "message-sent" : "message-received");
  div.setAttribute("data-id", msg.id);

  const timeText = msg.createdAt ? msg.createdAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

  div.innerHTML = `
    <strong class="username">${isMe ? "Me" : escapeHtml(msg.senderId)}</strong>
    <p>${escapeHtml(msg.text || "")}</p>
    <span class="timestamp">${timeText}</span>
  `;
  return div;
}

function escapeHtml(text) {
  if (!text) return "";
  return text.replace(/[&<>"']/g, (m) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m];
  });
}

// **This is the corrected function**
function watchNewMessages() {
  const messagesRef = collection(db, "chatrooms", roomId, "messages");
  const q = query(messagesRef, orderBy("createdAt", "asc"));

  onSnapshot(q, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === "added") {
        const msg = change.doc.data();
        msg.id = change.doc.id;
        msg.createdAt = msg.createdAt?.toDate();
        if (!msg.createdAt || renderedMessages.has(msg.id)) return;

        // Find the date of the last rendered message
        let lastRenderedDateStr = null;
        const lastMsgDiv = [...messagesContainer.children].reverse().find(el => el.classList.contains("message"));
        if (lastMsgDiv) {
            const lastMsg = renderedMessages.get(lastMsgDiv.dataset.id);
            if (lastMsg) {
                lastRenderedDateStr = dateString(lastMsg.createdAt);
            }
        }

        const msgDateStr = dateString(msg.createdAt);

        // If the date has changed from the last message's date, insert a new date separator.
        if (lastRenderedDateStr !== msgDateStr) {
          insertDateSeparator(msg.createdAt, false);
        }

        const isMe = msg.senderId === currentUserId;
        const messageDiv = createMessageDiv(msg, isMe);
        messagesContainer.appendChild(messageDiv);
        renderedMessages.set(msg.id, msg); // Store full message data

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

  if (backBtn) {
    backBtn.addEventListener("click", () => {
      window.location.href = "chatrooms.html";
    });
  }
}

function onInputChange() {
  updateSendButtonState();
  sendTypingStatus(true);
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => sendTypingStatus(false), 2000);
}

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
  const typingCollection = collection(db, "typing", roomId, "users");
  onSnapshot(typingCollection, (snapshot) => {
    const typingUsers = [];
    snapshot.forEach((docSnap) => {
      if (docSnap.id !== currentUserId && docSnap.data().isTyping) {
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

async function updateLastRead() {
  if (!currentUserId || !roomId) return;
  const readRef = doc(db, "reads", `${currentUserId}_${roomId}`);
  try {
    await setDoc(readRef, { lastReadTimestamp: serverTimestamp() }, { merge: true });
  } catch (e) {
    console.error("Failed to update last read timestamp", e);
  }
}

function updateSendButtonState() {
  const text = inputField.value.trim();
  sendButton.disabled = !text || text.length > 300 || isSending;
}

function isScrolledToBottom() {
  return messagesContainer.scrollHeight - messagesContainer.scrollTop <= messagesContainer.clientHeight + 10;
}

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

async function onScroll() {
  if (messagesContainer.scrollTop === 0) {
    await fetchMessages();
  }
  if (isScrolledToBottom()) {
    newMessagesBtn.style.display = "none";
    updateLastRead();
  } else {
    newMessagesBtn.style.display = "block";
  }
}

function searchMessages() {
  const queryText = searchInput.value.toLowerCase();
  searchResults.innerHTML = "";
  if (!queryText) {
    searchResults.style.display = "none";
    return;
  }

  const matched = [];
  renderedMessages.forEach((msg) => {
    const text = msg.text?.toLowerCase() || "";
    if (text.includes(queryText)) matched.push(msg);
  });

  if (matched.length === 0) {
    searchResults.style.display = "none";
    return;
  }

  matched.forEach((msg) => {
    const item = document.createElement("div");
    item.className = "search-result-item";
    item.textContent = msg.text;
    item.onclick = () => {
      const msgDiv = document.querySelector(`[data-id="${msg.id}"]`);
      if (msgDiv) {
        msgDiv.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      searchResults.style.display = "none";
      searchInput.value = "";
    };
    searchResults.appendChild(item);
  });

  searchResults.style.display = "block";
}

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