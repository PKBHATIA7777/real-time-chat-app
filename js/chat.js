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

import {
  getStorage,
  ref,
  uploadBytesResumable,
  getDownloadURL,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

const db = getFirestore(app);
const auth = getAuth(app);
const storage = getStorage(app);

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

const imageInput = document.getElementById("imageInput");
const imageUploadBtn = document.getElementById("imageUploadBtn");

let lastVisibleMsg = null;
let isFetching = false;
let renderedMessages = new Map();
let renderedDateSet = new Set();
let isSending = false;
let typingTimeout = null;

// Trigger file select dialog for image upload button
imageUploadBtn.addEventListener("click", () => imageInput.click());

// Handle image file selection + upload to Firebase Storage
imageInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  
  if (file.size > 5 * 1024 * 1024) {
    alert("File size exceeds 5MB limit.");
    return;
  }

  const messageId = doc(collection(db, "chatrooms", roomId, "messages")).id;
  const storageRef = ref(storage, `chatrooms/${roomId}/images/${messageId}.jpg`);

  const uploadTask = uploadBytesResumable(storageRef, file);

  uploadTask.on(
    "state_changed",
    (snapshot) => {
      const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
      console.log(`Upload is ${progress.toFixed(2)}% done`);
      // Optional: Implement progress UI update here
    },
    (error) => {
      alert("Image upload failed.");
      console.error(error);
    },
    async () => {
      try {
        const downloadURL = await getDownloadURL(uploadTask.snapshot.ref);
        await addDoc(collection(db, "chatrooms", roomId, "messages"), {
          imageUrl: downloadURL,
          senderId: currentUserId,
          createdAt: serverTimestamp(),
          messageType: "IMAGE",
        });
      } catch (err) {
        alert("Failed to send image message.");
        console.error(err);
      }
    }
  );

  imageInput.value = "";
});

// Helper: Get date string YYYY-MM-DD 
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

function insertDateSeparator(date, refNode = null) {
  const dateKey = dateString(date);
  if (renderedDateSet.has(dateKey)) return;

  const separator = document.createElement("div");
  separator.classList.add("date-separator");
  separator.setAttribute("data-date", dateKey);
  separator.textContent = formatDateLabel(date);

  if (refNode) {
    messagesContainer.insertBefore(separator, refNode);
  } else {
    messagesContainer.appendChild(separator);
  }

  renderedDateSet.add(dateKey);
}

// create div for message, including image rendering if applicable
function createMessageDiv(msg, isMe) {
  const div = document.createElement("div");
  div.classList.add("message", isMe ? "message-sent" : "message-received");
  div.setAttribute("data-id", msg.id);

  const timeText = msg.createdAt ? msg.createdAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

  let contentHtml = "";
  if (msg.messageType === "IMAGE" && msg.imageUrl) {
    contentHtml = `<img src="${msg.imageUrl}" alt="Image message" class="chat-image" />`;
  } else {
    contentHtml = `<p>${escapeHtml(msg.text || "")}</p>`;
  }

  div.innerHTML = `
    <strong class="username">${isMe ? "Me" : escapeHtml(msg.senderId)}</strong>
    ${contentHtml}
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
    ? query(messagesRef, orderBy("createdAt", "desc"), limit(PAGE_SIZE))
    : query(messagesRef, orderBy("createdAt", "desc"), startAfter(lastVisibleMsg), limit(PAGE_SIZE));

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

  messages.reverse();

  lastVisibleMsg = snapshot.docs[snapshot.docs.length - 1];
  prependMessages(messages);

  isFetching = false;
}

function prependMessages(messages) {
  let prevDateStr = null;

  messages.forEach((msg) => {
    if (renderedMessages.has(msg.id) || !msg.createdAt) return;

    const msgDateStr = dateString(msg.createdAt);

    if (prevDateStr !== msgDateStr) {
      insertDateSeparator(msg.createdAt);
    }

    const isMe = msg.senderId === currentUserId;
    const messageDiv = createMessageDiv(msg, isMe);
    messagesContainer.appendChild(messageDiv);

    renderedMessages.set(msg.id, { ...msg, element: messageDiv });
    prevDateStr = msgDateStr;
  });
}

function watchNewMessages() {
  const messagesRef = collection(db, "chatrooms", roomId, "messages");
  const q = query(messagesRef, orderBy("createdAt", "asc"));

  onSnapshot(q, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === "added" || change.type === "modified") {
        const msg = change.doc.data();
        msg.id = change.doc.id;

        if (!msg.createdAt) return;
        msg.createdAt = msg.createdAt.toDate();
        const isMe = msg.senderId === currentUserId;

        if (renderedMessages.has(msg.id)) {
          const existingMsg = renderedMessages.get(msg.id);
          existingMsg.element.innerHTML = `
            <strong class="username">${isMe ? "Me" : escapeHtml(msg.senderId)}</strong>
            ${msg.messageType === "IMAGE" && msg.imageUrl ? `<img src="${msg.imageUrl}" alt="Image message" class="chat-image" />` : `<p>${escapeHtml(msg.text || "")}</p>`}
            <span class="timestamp">${msg.createdAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          `;
          return;
        }

        const lastMsgEl = [...messagesContainer.children].reverse().find(el => el.classList.contains("message"));

        let lastRenderedDateStr = null;
        if (lastMsgEl) {
          const lastMsg = renderedMessages.get(lastMsgEl.dataset.id);
          if (lastMsg) lastRenderedDateStr = dateString(lastMsg.createdAt);
        }

        const msgDateStr = dateString(msg.createdAt);
        if (lastRenderedDateStr !== msgDateStr) {
          insertDateSeparator(msg.createdAt, messagesContainer.lastElementChild);
        }

        const messageDiv = createMessageDiv(msg, isMe);
        messagesContainer.appendChild(messageDiv);

        renderedMessages.set(msg.id, { ...msg, element: messageDiv });

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
      messageType: "TEXT",
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

