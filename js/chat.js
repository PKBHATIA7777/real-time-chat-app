import { app } from "./firebase-config.js";
import {
  getFirestore,
  collection,
  query,
  where,
  onSnapshot,
  orderBy,
  limit,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  serverTimestamp,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const db = getFirestore(app);
const auth = getAuth(app);

let currentUserId = null;
let chatroomsData = new Map();
let usersCache = []; // cache for user search
const chatroomsList = document.getElementById("chatroomsList");
const roomSearchInput = document.getElementById("roomSearchInput");
const btnCreateRoom = document.getElementById("btnCreateRoom");

// Modal elements
const createRoomModalBackdrop = document.getElementById("createRoomModalBackdrop");
const roomTitleInput = document.getElementById("roomTitleInput");
const memberSearchInput = document.getElementById("memberSearchInput");
const memberSuggestions = document.getElementById("memberSuggestions");
const selectedMembersDiv = document.getElementById("selectedMembers");
const createRoomError = document.getElementById("createRoomError");
const cancelCreateRoomBtn = document.getElementById("cancelCreateRoom");
const createRoomSubmitBtn = document.getElementById("createRoomSubmit");

let selectedMembers = new Map(); // Map userId -> userData

// --- Authentication and initialization ---
signInAnonymously(auth).catch(console.error);

onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUserId = user.uid;
    await initChatrooms();
    await preloadUsers();  // preload for search
  }
});

// --- Preload users for member search ---
async function preloadUsers() {
  try {
    const usersRef = collection(db, "users");
    const snapshot = await getDocs(usersRef);
    usersCache = [];
    snapshot.forEach(docSnap => {
      usersCache.push({ id: docSnap.id, ...docSnap.data() });
    });
  } catch (err) {
    console.error("Failed to preload users for search:", err);
  }
}

// --- Initialize chatrooms listener ---
async function initChatrooms() {
  const roomsQuery = query(collection(db, "chatrooms"), orderBy("createdAt", "desc"));

  onSnapshot(roomsQuery, (snapshot) => {
    snapshot.docChanges().forEach(async change => {
      const roomId = change.doc.id;
      const data = change.doc.data();
      if (change.type === "removed") {
        chatroomsData.delete(roomId);
        renderChatrooms();
      } else {
        chatroomsData.set(roomId, { ...data, id: roomId });
        await loadRoomAdditionalData(roomId);
      }
    });
    renderChatrooms();
  });
}

async function loadRoomAdditionalData(roomId) {
  try {
    // Last message
    const messagesRef = collection(db, `chatrooms/${roomId}/messages`);
    const lastMsgQuery = query(messagesRef, orderBy("createdAt", "desc"), limit(1));
    const lastMessagesSnapshot = await getDocs(lastMsgQuery);
    let lastMessage = null;
    lastMessagesSnapshot.forEach(doc => {
      lastMessage = doc.data();
    });

    // Mute status
    const muteDoc = await getDoc(doc(db, "mutes", `${currentUserId}_${roomId}`));
    const isMuted = muteDoc.exists() ? muteDoc.data().muted === true : false;

    // Unread count
    let unreadCount = 0;
    const readDoc = await getDoc(doc(db, "reads", `${currentUserId}_${roomId}`));
    if (readDoc.exists()) {
      const lastReadTimestamp = readDoc.data().lastReadTimestamp;
      if (lastReadTimestamp) {
        const unreadQuery = query(
          collection(db, `chatrooms/${roomId}/messages`),
          where("createdAt", ">", lastReadTimestamp)
        );
        const unreadSnap = await getDocs(unreadQuery);
        unreadCount = unreadSnap.size;
      }
    }

    // Update data & re-render
    const room = chatroomsData.get(roomId) || {};
    chatroomsData.set(roomId, { ...room, lastMessage, isMuted, unreadCount });
    renderChatrooms();
  } catch (err) {
    console.error("Error loading additional room data:", err);
  }
}

// --- Render the room list ---
function renderChatrooms() {
  chatroomsList.innerHTML = "";
  const filter = roomSearchInput.value.toLowerCase().trim();

  [...chatroomsData.values()]
    .filter(room => room.title.toLowerCase().includes(filter))
    .forEach(room => {
      const elem = document.createElement("div");
      elem.classList.add("room-item");
      elem.innerHTML = `
        <div class="room-left">
          <div class="room-title" title="${room.title}">${room.title}</div>
          <div class="room-last-message">${room.lastMessage ? room.lastMessage.text || 'Image' : ''}</div>
        </div>
        <div class="room-right">
          <div class="room-timestamp">${room.lastMessage && room.lastMessage.createdAt ?
            new Date(room.lastMessage.createdAt.seconds * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ''}</div>
          ${room.unreadCount > 0 && !room.isMuted ? `<div class="unread-count">${room.unreadCount}</div>` : ''}
          <button class="mute-toggle ${room.isMuted ? 'muted' : 'unmuted'}" title="${room.isMuted ? 'Unmute' : 'Mute'}">&#128263;</button>
        </div>`;
      elem.addEventListener("click", () => {
        window.location.href = `chat.html?roomId=${room.id}`;
      });
      const muteBtn = elem.querySelector(".mute-toggle");
      muteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await toggleMute(room.id, !room.isMuted);
      });
      chatroomsList.appendChild(elem);
    });
}

// --- Toggle mute ---
async function toggleMute(roomId, mute) {
  try {
    await setDoc(doc(db, "mutes", `${currentUserId}_${roomId}`), { muted: mute });
    const room = chatroomsData.get(roomId);
    if (room) {
      room.isMuted = mute;
      chatroomsData.set(roomId, room);
      renderChatrooms();
    }
  } catch (err) {
    console.error("Failed to update mute status:", err);
  }
}

// --- Search filter ---
roomSearchInput.addEventListener("input", () => renderChatrooms());

// --- Create Room Modal handlers ---
btnCreateRoom.addEventListener("click", () => {
  openCreateRoomModal();
});

cancelCreateRoomBtn.addEventListener("click", () => {
  closeCreateRoomModal();
});

// --- Selected members management ---
function renderSelectedMembers() {
  selectedMembersDiv.innerHTML = "";
  selectedMembers.forEach(user => {
    const chip = document.createElement("div");
    chip.className = "member-chip";
    chip.textContent = user.displayName || user.email || "Unknown";
    const removeBtn = document.createElement("span");
    removeBtn.className = "remove-btn";
    removeBtn.textContent = "×";
    removeBtn.title = "Remove";
    removeBtn.onclick = (e) => {
      e.stopPropagation();
      selectedMembers.delete(user.id);
      renderSelectedMembers();
    };
    chip.appendChild(removeBtn);
    selectedMembersDiv.appendChild(chip);
  });
}

memberSearchInput.addEventListener("input", () => {
  const text = memberSearchInput.value.toLowerCase().trim();
  if (!text) {
    memberSuggestions.style.display = "none";
    memberSuggestions.innerHTML = "";
    return;
  }
  const filtered = usersCache.filter(user =>
    (user.displayName && user.displayName.toLowerCase().includes(text)) ||
    (user.email && user.email.toLowerCase().includes(text))
  ).filter(user => !selectedMembers.has(user.id));
  showMemberSuggestions(filtered.slice(0, 5)); // show max 5
});

function showMemberSuggestions(arr) {
  memberSuggestions.innerHTML = "";
  if (arr.length === 0) {
    memberSuggestions.style.display = "none";
    return;
  }
  arr.forEach(user => {
    const div = document.createElement("div");
    div.textContent = user.displayName || user.email || "Unknown";
    div.title = user.email || "";
    div.onclick = () => {
      selectedMembers.set(user.id, user);
      renderSelectedMembers();
      memberSuggestions.style.display = "none";
      memberSearchInput.value = "";
    };
    memberSuggestions.appendChild(div);
  });
  memberSuggestions.style.display = "block";
}

// --- Open & Close modal ---
function openCreateRoomModal() {
  createRoomError.textContent = "";
  roomTitleInput.value = "";
  memberSearchInput.value = "";
  memberSuggestions.innerHTML = "";
  memberSuggestions.style.display = "none";
  selectedMembers.clear();

  // Automatically add current user as member
  const currentUser = usersCache.find(u => u.id === currentUserId);
  if (currentUser) {
    selectedMembers.set(currentUserId, currentUser);
  }
  renderSelectedMembers();

  createRoomModalBackdrop.style.display = "flex";
  roomTitleInput.focus();
}

function closeCreateRoomModal() {
  createRoomModalBackdrop.style.display = "none";
}

// --- Submit Create Room ---
createRoomSubmitBtn.addEventListener("click", () => {
  createRoomError.textContent = "";
  const title = roomTitleInput.value.trim();

  if (!title) {
    createRoomError.textContent = "Room title is required.";
    roomTitleInput.focus();
    return;
  }
  if (selectedMembers.size === 0) {
    createRoomError.textContent = "Add at least one member.";
    memberSearchInput.focus();
    return;
  }

  createRoom(title, Array.from(selectedMembers.keys()));
});

// --- Room creation function ---
async function createRoom(title, memberIds) {
  try {
    // Generate new room doc reference with auto ID
    const roomsColl = collection(db, "chatrooms");
    const newRoomRef = doc(roomsColl);

    // Batch writes for atomicity
    const batch = writeBatch(db);

    // Room doc
    batch.set(newRoomRef, {
      title,
      type: "group",
      createdBy: currentUserId,
      createdAt: serverTimestamp()
    });

    // Add members subcollection, setting creator as admin
    memberIds.forEach(uid => {
      const memberDoc = doc(db, "chatrooms", newRoomRef.id, "members", uid);
      batch.set(memberDoc, {
        role: uid === currentUserId ? "admin" : "member",
        joinedAt: serverTimestamp()
      });
    });

    await batch.commit();

    closeCreateRoomModal();

    // Redirect to the new chat room or just refresh list (optional)
    window.location.href = `chat.html?roomId=${newRoomRef.id}`;
  } catch (err) {
    createRoomError.textContent = "Failed to create room. Please try again.";
    console.error("Room creation error:", err);
  }
}

// Close modal clicking outside or pressing Escape key
createRoomModalBackdrop.addEventListener("click", e => {
  if (e.target === createRoomModalBackdrop) closeCreateRoomModal();
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && createRoomModalBackdrop.style.display === "flex") {
    closeCreateRoomModal();
  }
});
