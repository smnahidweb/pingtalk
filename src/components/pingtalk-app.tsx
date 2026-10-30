"use client";

import {
  ArrowLeft,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Image as ImageIcon,
  Info,
  LogOut,
  MessageCircle,
  MoreHorizontal,
  Phone,
  Pencil,
  Plus,
  Search,
  Send,
  Smile,
  Sun,
  Trash2,
  Users,
  X,
  Moon,
  Video,
} from "lucide-react";
import {
  FormEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { io, type Socket } from "socket.io-client";
import type { AuthUser } from "@/lib/auth-client";
import {
  apiRequest,
  type ApiConversation,
  type ApiMessage,
} from "@/lib/api";
import { useCalling } from "@/lib/use-calling";
import CallingUI from "@/components/calling-ui";

type Message = {
  id: string;
  sender: "me" | "other";
  text: string;
  time: string;
  read?: boolean;
  author?: string;
  edited?: boolean;
  deleted?: boolean;
};

type Member = {
  id: string;
  name: string;
  tone: string;
  status?: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
};

type Conversation = {
  id: string;
  name: string;
  subtitle: string;
  lastMessage: string;
  time: string;
  unread: number;
  online: boolean;
  group: boolean;
  memberCount: number;
  tone: string;
  members: Member[];
  messages: Message[];
};

type ConversationFilter = "all" | "unread" | "groups";
type NewConversationMode = "private" | "group" | "add";
type MessagePageState = {
  conversationId: string;
  cursor: string | null;
  hasMore: boolean;
};
type UserSearchState = {
  query: string;
  users: Array<{ id: string; name: string; image: string | null }>;
  loading: boolean;
  error: string;
  nextCursor: string | null;
  hasMore: boolean;
};

function diagnosticError(error: Error | string) {
  return {
    type:
      error instanceof Error && "type" in error
        ? String(error.type)
        : undefined,
    message: error instanceof Error ? error.message : error,
  };
}

function closeDescription(details?: Error | { description: string }) {
  return details instanceof Error ? details.message : details?.description;
}

const avatarTones = ["violet", "blue", "rose", "green", "gold", "orange"];

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function mapMessage(message: ApiMessage, userId: string, group: boolean): Message {
  const isMine = message.sender.id === userId;
  return {
    id: message.id,
    sender: isMine ? "me" : "other",
    text: message.content,
    time: formatTime(message.createdAt),
    read: message.read,
    edited: Boolean(message.editedAt),
    deleted: Boolean(message.deletedAt),
    author: group && !isMine ? message.sender.name.split(" ")[0] : undefined,
  };
}

function mapConversation(
  conversation: ApiConversation,
  userId: string,
  index: number,
): Conversation {
  const group = conversation.type === "GROUP";
  const members: Member[] = conversation.members.map((member, memberIndex) => ({
    id: member.id,
    name: member.id === userId ? "You" : member.name,
    tone: avatarTones[memberIndex % avatarTones.length],
    status: member.id === userId ? "You" : "PingTalk member",
    role: member.role,
  }));
  const otherMember = conversation.members.find((member) => member.id !== userId);
  const lastMessage = conversation.lastMessage;

  return {
    id: conversation.id,
    name: group ? conversation.title : otherMember?.name ?? "Private conversation",
    subtitle: group ? "Group conversation" : "PingTalk member",
    lastMessage: lastMessage
      ? `${lastMessage.senderId === userId ? "You" : lastMessage.senderName}: ${lastMessage.content}`
      : "No messages yet",
    time: lastMessage ? formatTime(lastMessage.createdAt) : "",
    unread: conversation.unreadCount,
    memberCount: conversation.memberCount,
    online: false,
    group,
    tone: avatarTones[index % avatarTones.length],
    members,
    messages: [],
  };
}

function initials(name: string) {
  return name
    .split(" ")
    .filter((part) => part !== "You")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function Avatar({
  name,
  tone,
  size = "regular",
  online = false,
}: {
  name: string;
  tone: string;
  size?: "small" | "regular" | "large";
  online?: boolean;
}) {
  return (
    <span className={`avatar avatar--${tone} avatar--${size}`} aria-hidden="true">
      {initials(name)}
      {online && <span className="avatar__online" />}
    </span>
  );
}

export default function PingTalkApp({
  user,
  onLogout,
}: {
  user: AuthUser;
  onLogout: () => void;
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState("");
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [conversationsError, setConversationsError] = useState("");
  const [conversationCursor, setConversationCursor] = useState<string | null>(null);
  const [conversationsHasMore, setConversationsHasMore] = useState(false);
  const [loadingMoreConversations, setLoadingMoreConversations] = useState(false);
  const [messagePage, setMessagePage] = useState<MessagePageState>({
    conversationId: "",
    cursor: null,
    hasMore: false,
  });
  const [olderMessagesLoading, setOlderMessagesLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [reloadConversations, setReloadConversations] = useState(0);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [filter, setFilter] = useState<ConversationFilter>("all");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [profileOpen, setProfileOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [newConversationOpen, setNewConversationOpen] = useState(false);
  const [newConversationMode, setNewConversationMode] =
    useState<NewConversationMode>("private");
  const [groupName, setGroupName] = useState("");
  const [selectedParticipantIds, setSelectedParticipantIds] = useState<string[]>([]);
  const [groupBusy, setGroupBusy] = useState(false);
  const [groupNameEditing, setGroupNameEditing] = useState(false);
  const [groupNameDraft, setGroupNameDraft] = useState("");
  const [userSearch, setUserSearch] = useState("");
  const [userSearchState, setUserSearchState] = useState<UserSearchState>({
    query: "",
    users: [],
    loading: false,
    error: "",
    nextCursor: null,
    hasMore: false,
  });
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingMessageText, setEditingMessageText] = useState("");
  const [messageMutationId, setMessageMutationId] = useState("");
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [profileName, setProfileName] = useState(user.name);
  const [profileNameDraft, setProfileNameDraft] = useState(user.name);
  const [profileStatusDraft, setProfileStatusDraft] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const activeConversationIdRef = useRef(activeId);
  activeConversationIdRef.current = activeId;
  const calling = useCalling(socket, user.id);

  const activeConversation = conversations.find(
    (conversation) => conversation.id === activeId,
  ) ?? {
    id: "",
    name: "Choose a conversation",
    subtitle: "Your messages will appear here.",
    lastMessage: "",
    time: "",
    unread: 0,
    online: false,
    group: false,
    memberCount: 0,
    tone: "violet",
    members: [],
    messages: [],
  };
  const isMobileConversationOpen =
    mobileChatOpen && Boolean(activeConversation.id);
  const messagesLoading =
    Boolean(activeConversation.id) &&
    messagePage.conversationId !== activeConversation.id;
  const messageCursor =
    messagePage.conversationId === activeConversation.id
      ? messagePage.cursor
      : null;
  const hasOlderMessages =
    messagePage.conversationId === activeConversation.id &&
    messagePage.hasMore;

  const visibleConversations = conversations.filter((conversation) => {
    const matchesFilter =
      filter === "all" ||
      (filter === "unread" && conversation.unread > 0) ||
      (filter === "groups" && conversation.group);
    const searchText =
      `${conversation.name} ${conversation.lastMessage} ${conversation.subtitle}`.toLowerCase();
    return matchesFilter && searchText.includes(query.toLowerCase().trim());
  });
  const eligibleSearchUsers = userSearchState.users.filter(
    (result) =>
      newConversationMode !== "add" ||
      !activeConversation.members.some((member) => member.id === result.id),
  );

  useEffect(() => {
    let active = true;
    void apiRequest<{
      conversations: ApiConversation[];
      nextCursor: string | null;
      hasMore: boolean;
    }>("/conversations?limit=20")
      .then(({ conversations: responseConversations, nextCursor, hasMore }) => {
        if (!active) return;
        const mapped = responseConversations.map((conversation, index) =>
          mapConversation(conversation, user.id, index),
        );
        setConversations((current) =>
          mapped.map((conversation) => ({
            ...conversation,
            messages:
              current.find((item) => item.id === conversation.id)?.messages ?? [],
          })),
        );
        setConversationCursor(nextCursor);
        setConversationsHasMore(hasMore);
        setActiveId((current) =>
          current && mapped.some((conversation) => conversation.id === current)
            ? current
            : mapped[0]?.id ?? "",
        );
      })
      .catch((error: unknown) => {
        if (active) {
          setConversations([]);
          setActiveId("");
          setConversationCursor(null);
          setConversationsHasMore(false);
          setConversationsError(
            error instanceof Error ? error.message : "Unable to load conversations.",
          );
        }
      })
      .finally(() => {
        if (active) setConversationsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [user.id, reloadConversations]);

  useEffect(() => {
    if (!activeConversation.id) return;
    let active = true;
    const conversationId = activeConversation.id;
    void apiRequest<{
      messages: ApiMessage[];
      nextCursor: string | null;
      hasMore: boolean;
    }>(`/conversations/${encodeURIComponent(conversationId)}/messages?limit=50`)
      .then(async (page) => {
        if (!active) return;
        const messages = page.messages.map((message) =>
          mapMessage(message, user.id, activeConversation.group),
        );
        setConversations((current) =>
          current.map((conversation) =>
            conversation.id === conversationId
              ? { ...conversation, messages, unread: 0 }
              : conversation,
          ),
        );
        setMessagePage({
          conversationId,
          cursor: page.nextCursor,
          hasMore: page.hasMore,
        });
        await apiRequest(
          `/conversations/${encodeURIComponent(conversationId)}/read`,
          { method: "POST" },
        );
      })
      .catch((error: unknown) => {
        if (active) {
          setMessagePage({
            conversationId,
            cursor: null,
            hasMore: false,
          });
          setNotice(
            error instanceof Error ? error.message : "Unable to load messages.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [activeConversation.id, activeConversation.group, user.id]);

  useEffect(() => {
    const client = io(window.location.origin, {
      withCredentials: true,
      transports: ["polling", "websocket"],
      addTrailingSlash: false,
      autoConnect: false,
    });
    setSocket(client);
    return () => {
      client.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!socket) return;
    socketRef.current = socket;
    const observedEngines = new WeakSet<object>();
    const observedTransports = new WeakSet<object>();

    const observeTransport = (transport: typeof socket.io.engine.transport) => {
      if (observedTransports.has(transport)) return;
      observedTransports.add(transport);
      transport.on("error", (error) => {
        console.error("[PingTalk realtime] transport error", {
          transport: transport.name,
          ...diagnosticError(error),
        });
      });
      transport.on("close", (details) => {
        console.warn("[PingTalk realtime] transport closed", {
          transport: transport.name,
          reason: closeDescription(details),
        });
      });
    };

    const observeEngine = () => {
      const engine = socket.io.engine;
      if (observedEngines.has(engine)) return;
      observedEngines.add(engine);
      console.info("[PingTalk realtime] engine opened", {
        transport: engine.transport.name,
      });
      observeTransport(engine.transport);
      engine.on("error", (error) => {
        console.error("[PingTalk realtime] engine error", {
          ...diagnosticError(error),
        });
      });
      engine.on("close", (reason, details) => {
        console.warn("[PingTalk realtime] engine closed", {
          reason,
          description: closeDescription(details),
        });
      });
      engine.on("upgrade", (transport) => {
        console.info("[PingTalk realtime] transport upgraded", {
          transport: transport.name,
        });
        observeTransport(transport);
      });
      engine.on("upgradeError", (error) => {
        console.warn("[PingTalk realtime] transport upgrade failed", {
          ...diagnosticError(error),
        });
      });
    };

    const handleConnect = () => {
      console.info("[PingTalk realtime] connected", {
        transport: socket.io.engine.transport.name,
      });
      setNotice((current) =>
        current === "Realtime connection lost. Message history will keep syncing on refresh."
          ? ""
          : current,
      );
      const conversationId = activeConversationIdRef.current;
      if (conversationId) {
        socket.emit("conversation:join", conversationId);
      }
    };

    const handleDisconnect = (reason: string) => {
      console.warn("[PingTalk realtime] disconnected", { reason });
      if (reason !== "io client disconnect") {
        setNotice("Realtime connection lost. Message history will keep syncing on refresh.");
      }
    };

    const handleReconnectAttempt = (attempt: number) => {
      console.info("[PingTalk realtime] reconnect attempt", { attempt });
    };

    const handleReconnect = (attempt: number) => {
      console.info("[PingTalk realtime] reconnected", { attempt });
    };

    const handleReconnectError = (error: Error) => {
      console.warn("[PingTalk realtime] reconnect error", {
        message: error.message,
      });
    };

    const handleReconnectFailed = () => {
      console.error("[PingTalk realtime] reconnection failed");
    };

    const handleManagerClose = (
      reason: string,
      details?: Error | { description: string },
    ) => {
      console.warn("[PingTalk realtime] manager closed", {
        reason,
        description: closeDescription(details),
      });
    };

    const handleNewMessage = (payload: { conversationId: string; message: ApiMessage }) => {
      if (payload.message.sender.id === user.id) return;
      const conversationId = payload.conversationId;

      setConversations((current) => {
        const index = current.findIndex((conversation) => conversation.id === conversationId);
        if (index === -1) return current;
        const existingConversation = current[index];
        if (existingConversation.messages.some((message) => message.id === payload.message.id)) {
          return current;
        }

        const mapped = mapMessage(payload.message, user.id, existingConversation.group);
        return current.map((conversation) => {
          if (conversation.id !== conversationId) return conversation;
          const nextMessages =
            conversation.id === activeConversationIdRef.current
              ? [...conversation.messages, mapped]
              : conversation.messages;
          return {
            ...conversation,
            lastMessage: `${payload.message.sender.name}: ${payload.message.content}`,
            time: formatTime(payload.message.createdAt),
            unread:
              conversation.id === activeConversationIdRef.current
                ? 0
                : conversation.unread + 1,
            messages: nextMessages,
          };
        });
      });
    };

    const handleMessageRead = (payload: {
      conversationId: string;
      messageId: string;
      userId: string;
    }) => {
      if (payload.userId === user.id) return;
      setConversations((current) =>
        current.map((conversation) => {
          if (conversation.id !== payload.conversationId) return conversation;
          return {
            ...conversation,
            messages: conversation.messages.map((message) =>
              message.id === payload.messageId ? { ...message, read: true } : message,
            ),
          };
        }),
      );
    };

    const handleConnectError = (error: Error) => {
      console.error("[PingTalk realtime] connection rejected or failed", {
        message: error.message,
      });
      setNotice("Realtime connection lost. Message history will keep syncing on refresh.");
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("message:new", handleNewMessage);
    socket.on("message:read", handleMessageRead);
    socket.on("connect_error", handleConnectError);
    socket.io.on("open", observeEngine);
    socket.io.on("close", handleManagerClose);
    socket.io.on("reconnect_attempt", handleReconnectAttempt);
    socket.io.on("reconnect", handleReconnect);
    socket.io.on("reconnect_error", handleReconnectError);
    socket.io.on("reconnect_failed", handleReconnectFailed);
    socket.connect();

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("message:new", handleNewMessage);
      socket.off("message:read", handleMessageRead);
      socket.off("connect_error", handleConnectError);
      socket.io.off("open", observeEngine);
      socket.io.off("close", handleManagerClose);
      socket.io.off("reconnect_attempt", handleReconnectAttempt);
      socket.io.off("reconnect", handleReconnect);
      socket.io.off("reconnect_error", handleReconnectError);
      socket.io.off("reconnect_failed", handleReconnectFailed);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [user.id, socket]);

  useEffect(() => {
    if (socketRef.current && socketRef.current.connected && activeConversation.id) {
      socketRef.current.emit("conversation:join", activeConversation.id);
    }
  }, [activeConversation.id]);

  useEffect(() => {
    if (
      window.matchMedia("(max-width: 760px)").matches &&
      !isMobileConversationOpen
    ) {
      return;
    }
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeId, activeConversation.messages.length, isMobileConversationOpen]);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape") {
        setProfileOpen(false);
        setDetailsOpen(false);
        setNewConversationOpen(false);
        setProfileEditorOpen(false);
      }
    }

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  useEffect(() => {
    const search = userSearch.trim();
    if (!newConversationOpen || search.length < 2) return;

    let active = true;
    const timer = window.setTimeout(() => {
      setUserSearchState({
        query: search,
        users: [],
        loading: true,
        error: "",
        nextCursor: null,
        hasMore: false,
      });
      void apiRequest<{
        users: Array<{ id: string; name: string; image: string | null }>;
        nextCursor: string | null;
        hasMore: boolean;
      }>(`/users?query=${encodeURIComponent(search)}&limit=20`)
        .then(({ users, nextCursor, hasMore }) => {
          if (active) {
            setUserSearchState({
              query: search,
              users,
              loading: false,
              error: "",
              nextCursor,
              hasMore,
            });
          }
        })
        .catch((error: unknown) => {
          if (active) {
            setUserSearchState({
              query: search,
              users: [],
              loading: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Unable to search users.",
              nextCursor: null,
              hasMore: false,
            });
          }
        })
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [newConversationOpen, userSearch]);

  function selectConversation(conversation: Conversation) {
    setActiveId(conversation.id);
    setMobileChatOpen(true);
    setConversations((current) =>
      current.map((item) =>
        item.id === conversation.id ? { ...item, unread: 0 } : item,
      ),
    );
    setDetailsOpen(false);
  }

  function retryConversations() {
    setConversationsLoading(true);
    setConversationsError("");
    setConversationCursor(null);
    setReloadConversations((current) => current + 1);
  }

  async function loadMoreConversations() {
    if (!conversationCursor || loadingMoreConversations) return;
    setLoadingMoreConversations(true);
    try {
      const page = await apiRequest<{
        conversations: ApiConversation[];
        nextCursor: string | null;
        hasMore: boolean;
      }>(
        `/conversations?limit=20&cursor=${encodeURIComponent(conversationCursor)}`,
      );
      setConversations((current) => {
        const existingIds = new Set(current.map((conversation) => conversation.id));
        const additions = page.conversations
          .filter((conversation) => !existingIds.has(conversation.id))
          .map((conversation, index) =>
            mapConversation(conversation, user.id, current.length + index),
          );
        return [...current, ...additions];
      });
      setConversationCursor(page.nextCursor);
      setConversationsHasMore(page.hasMore);
    } catch (error) {
      setConversationsError(
        error instanceof Error ? error.message : "Unable to load more conversations.",
      );
    } finally {
      setLoadingMoreConversations(false);
    }
  }

  function openNewConversation() {
    setNewConversationMode("private");
    setGroupName("");
    setSelectedParticipantIds([]);
    setUserSearch("");
    setUserSearchState({
      query: "",
      users: [],
      loading: false,
      error: "",
      nextCursor: null,
      hasMore: false,
    });
    setNewConversationOpen(true);
  }

  async function loadMoreUsers() {
    const cursor = userSearchState.nextCursor;
    const search = userSearch.trim();
    if (!cursor || !search || userSearchState.loading) return;
    setUserSearchState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const page = await apiRequest<{
        users: Array<{ id: string; name: string; image: string | null }>;
        nextCursor: string | null;
        hasMore: boolean;
      }>(
        `/users?query=${encodeURIComponent(search)}&limit=20&cursor=${encodeURIComponent(cursor)}`,
      );
      setUserSearchState((current) => ({
        ...current,
        users: [...current.users, ...page.users],
        loading: false,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      }));
    } catch (error) {
      setUserSearchState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : "Unable to load more people.",
      }));
    }
  }

  function openAddParticipant() {
    setNewConversationMode("add");
    setUserSearch("");
    setUserSearchState({
      query: "",
      users: [],
      loading: false,
      error: "",
      nextCursor: null,
      hasMore: false,
    });
    setNewConversationOpen(true);
  }

  async function startPrivateConversation(participantId: string) {
    if (creatingConversation) return;
    setCreatingConversation(true);
    setNotice("");
    try {
      const { conversation } = await apiRequest<{
        conversation: { id: string };
      }>("/conversations/private", {
        method: "POST",
        body: JSON.stringify({ participantId }),
      });
      setNewConversationOpen(false);
      setUserSearch("");
      setActiveId(conversation.id);
      setMobileChatOpen(true);
      retryConversations();
    } catch (error) {
      setUserSearchState({
        query: userSearch.trim(),
        users: userSearchState.users,
        loading: false,
        error:
          error instanceof Error
            ? error.message
            : "Unable to start this conversation.",
        nextCursor: userSearchState.nextCursor,
        hasMore: userSearchState.hasMore,
      });
    } finally {
      setCreatingConversation(false);
    }
  }

  async function createGroupConversation() {
    const name = groupName.trim();
    if (!name || selectedParticipantIds.length === 0 || groupBusy) return;
    setGroupBusy(true);
    setUserSearchState((current) => ({ ...current, error: "" }));
    try {
      const { conversation } = await apiRequest<{ conversation: { id: string } }>(
        "/conversations/groups",
        {
          method: "POST",
          body: JSON.stringify({
            name,
            participantIds: selectedParticipantIds,
          }),
        },
      );
      setNewConversationOpen(false);
      setActiveId(conversation.id);
      setMobileChatOpen(true);
      retryConversations();
    } catch (error) {
      setUserSearchState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "Unable to create this group.",
      }));
    } finally {
      setGroupBusy(false);
    }
  }

  async function addGroupParticipant(participantId: string) {
    if (!activeConversation.id || groupBusy) return;
    setGroupBusy(true);
    try {
      await apiRequest(
        `/conversations/${encodeURIComponent(activeConversation.id)}/participants`,
        { method: "POST", body: JSON.stringify({ userId: participantId }) },
      );
      setNewConversationOpen(false);
      setDetailsOpen(false);
      retryConversations();
    } catch (error) {
      setUserSearchState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "Unable to add this person.",
      }));
    } finally {
      setGroupBusy(false);
    }
  }

  async function removeGroupParticipant(participantId: string) {
    if (!activeConversation.id || groupBusy) return;
    setGroupBusy(true);
    setNotice("");
    try {
      await apiRequest(
        `/conversations/${encodeURIComponent(activeConversation.id)}/participants/${encodeURIComponent(participantId)}`,
        { method: "DELETE" },
      );
      setDetailsOpen(false);
      retryConversations();
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Unable to remove this participant.",
      );
    } finally {
      setGroupBusy(false);
    }
  }

  async function leaveGroup() {
    if (!activeConversation.id || groupBusy) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "Leave this group? If you are the owner, ownership will pass to the longest-standing member.",
      )
    ) {
      return;
    }
    setGroupBusy(true);
    setNotice("");
    try {
      await apiRequest(
        `/conversations/${encodeURIComponent(activeConversation.id)}/leave`,
        { method: "POST" },
      );
      setDetailsOpen(false);
      setActiveId("");
      retryConversations();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to leave this group.");
    } finally {
      setGroupBusy(false);
    }
  }

  async function updateGroupName() {
    const name = groupNameDraft.trim();
    if (!activeConversation.id || !name || groupBusy) return;
    setGroupBusy(true);
    try {
      await apiRequest(
        `/conversations/${encodeURIComponent(activeConversation.id)}`,
        { method: "PATCH", body: JSON.stringify({ name }) },
      );
      setGroupNameEditing(false);
      retryConversations();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to update the group name.");
    } finally {
      setGroupBusy(false);
    }
  }

  async function openProfileEditor() {
    setProfileSaving(true);
    setNotice("");
    try {
      const { user: profile } = await apiRequest<{
        user: { name: string; profile: { statusMessage: string | null } | null };
      }>("/me");
      setProfileNameDraft(profile.name);
      setProfileStatusDraft(profile.profile?.statusMessage ?? "");
      setProfileEditorOpen(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to load your profile.");
    } finally {
      setProfileSaving(false);
    }
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = profileNameDraft.trim();
    if (name.length < 2 || profileSaving) return;
    setProfileSaving(true);
    setNotice("");
    try {
      const { user: profile } = await apiRequest<{
        user: { name: string };
      }>("/me", {
        method: "PATCH",
        body: JSON.stringify({
          name,
          statusMessage: profileStatusDraft.trim() || null,
        }),
      });
      setProfileName(profile.name);
      setProfileEditorOpen(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to save your profile.");
    } finally {
      setProfileSaving(false);
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !activeConversation.id || sending) return;

    setSending(true);
    setNotice("");
    try {
      const { message } = await apiRequest<{ message: ApiMessage }>(
        `/conversations/${encodeURIComponent(activeConversation.id)}/messages`,
        { method: "POST", body: JSON.stringify({ content: text }) },
      );
      const mappedMessage = mapMessage(
        message,
        user.id,
        activeConversation.group,
      );
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === activeConversation.id
            ? {
                ...conversation,
                lastMessage: `You: ${text}`,
                time: mappedMessage.time,
                unread: 0,
                messages: [...conversation.messages, mappedMessage],
              }
            : conversation,
        ),
      );
      setDraft("");
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Unable to send this message.",
      );
    } finally {
      setSending(false);
    }
  }

  async function saveMessageEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const messageId = editingMessageId;
    const content = editingMessageText.trim();
    if (!messageId || !content || messageMutationId) return;
    setMessageMutationId(messageId);
    setNotice("");
    try {
      const { message } = await apiRequest<{
        message: { id: string; content: string; editedAt: string };
      }>(`/messages/${encodeURIComponent(messageId)}`, {
        method: "PATCH",
        body: JSON.stringify({ content }),
      });
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === activeConversation.id
            ? {
                ...conversation,
              lastMessage: conversation.messages.at(-1)?.id === messageId
                  ? `You: ${message.content}`
                  : conversation.lastMessage,
                messages: conversation.messages.map((item) =>
                  item.id === messageId
                    ? { ...item, text: message.content, edited: true }
                    : item,
                ),
              }
            : conversation,
        ),
      );
      setEditingMessageId(null);
      setEditingMessageText("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to edit this message.");
    } finally {
      setMessageMutationId("");
    }
  }

  async function deleteMessage(messageId: string) {
    if (messageMutationId) return;
    setMessageMutationId(messageId);
    setNotice("");
    try {
      await apiRequest(`/messages/${encodeURIComponent(messageId)}`, {
        method: "DELETE",
      });
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === activeConversation.id
            ? {
                ...conversation,
                lastMessage: conversation.messages.at(-1)?.id === messageId
                  ? "You: Message deleted"
                  : conversation.lastMessage,
                messages: conversation.messages.map((item) =>
                  item.id === messageId
                    ? { ...item, text: "Message deleted", deleted: true, edited: false }
                    : item,
                ),
              }
            : conversation,
        ),
      );
      if (editingMessageId === messageId) setEditingMessageId(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to delete this message.");
    } finally {
      setMessageMutationId("");
    }
  }

  async function loadOlderMessages() {
    if (!messageCursor || !activeConversation.id || olderMessagesLoading) return;
    setOlderMessagesLoading(true);
    try {
      const page = await apiRequest<{
        messages: ApiMessage[];
        nextCursor: string | null;
        hasMore: boolean;
      }>(
        `/conversations/${encodeURIComponent(activeConversation.id)}/messages?limit=50&cursor=${encodeURIComponent(messageCursor)}`,
      );
      const older = page.messages.map((message) =>
        mapMessage(message, user.id, activeConversation.group),
      );
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === activeConversation.id
            ? { ...conversation, messages: [...older, ...conversation.messages] }
            : conversation,
        ),
      );
      setMessagePage({
        conversationId: activeConversation.id,
        cursor: page.nextCursor,
        hasMore: page.hasMore,
      });
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Unable to load older messages.",
      );
    } finally {
      setOlderMessagesLoading(false);
    }
  }

  function openSearch() {
    searchRef.current?.focus();
    document.querySelector(".conversation-list")?.scrollIntoView({ behavior: "smooth" });
  }

  return (
    <main className={`app-shell theme-${theme} ${isMobileConversationOpen ? "mobile-chat-open" : ""}`}>
      <nav className="nav-rail" aria-label="Main navigation">
        <a className="brand-mark" href="#" aria-label="PingTalk home">
          <MessageCircle size={20} strokeWidth={2.2} />
          <span className="brand-mark__dot" />
        </a>
        <div className="nav-rail__actions">
          <button className="rail-button is-active" aria-label="Messages">
            <MessageCircle size={20} />
          </button>
          <button className="rail-button" onClick={openSearch} aria-label="Search conversations">
            <Search size={20} />
          </button>
          <span className="rail-divider" />
          <button
            className="rail-button"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          >
            {theme === "dark" ? <Sun size={20} /> : <Moon size={20} />}
          </button>
        </div>
        <div className="nav-rail__bottom">
          <button
            className={`rail-profile ${profileOpen ? "is-open" : ""}`}
            onClick={() => setProfileOpen((open) => !open)}
            aria-label="Open your profile"
            aria-expanded={profileOpen}
          >
            <Avatar name={profileName} tone="me" size="small" />
            <span className="presence-dot" />
          </button>
        </div>
      </nav>

      <aside className={`conversation-sidebar ${isMobileConversationOpen ? "mobile-chat-open" : ""}`}>
        <header className="sidebar-header">
          <div className="sidebar-heading">
            <div>
              <span className="eyebrow">YOUR SPACE</span>
              <h1>Messages</h1>
            </div>
            <button className="icon-button" aria-label="Start a new conversation" onClick={openNewConversation}>
              <Plus size={19} />
            </button>
          </div>
          <label className="search-field">
            <Search size={17} />
            <input
              ref={searchRef}
              type="search"
              placeholder="Search conversations"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search conversations"
            />
            {query ? (
              <button type="button" className="search-clear" onClick={() => setQuery("")} aria-label="Clear search">
                <X size={14} />
              </button>
            ) : (
              <kbd>⌘ K</kbd>
            )}
          </label>
          <div className="filter-tabs" role="tablist" aria-label="Filter conversations">
            {([
              ["all", "All"],
              ["unread", "Unread"],
              ["groups", "Groups"],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                role="tab"
                aria-selected={filter === value}
                className={filter === value ? "is-active" : ""}
                onClick={() => setFilter(value)}
              >
                {label}
                {value === "unread" && (
                  <span className="filter-count">
                    {conversations.filter((conversation) => conversation.unread > 0).length}
                  </span>
                )}
              </button>
            ))}
          </div>
        </header>

        <div className="conversation-list">
          {conversationsLoading ? (
            <div className="empty-search" role="status">
              <strong>Loading conversations…</strong>
            </div>
          ) : conversationsError ? (
            <div className="empty-search" role="alert">
              <strong>Couldn’t load conversations</strong>
              <span>{conversationsError}</span>
              <button
                type="button"
                className="text-icon-button"
                onClick={retryConversations}
              >
                Try again
              </button>
            </div>
          ) : conversations.length === 0 ? (
            <div className="empty-search">
              <span className="empty-search__icon"><MessageCircle size={18} /></span>
              <strong>No conversations yet</strong>
              <span>Start one with someone you know.</span>
              <button
                type="button"
                className="text-icon-button"
                onClick={openNewConversation}
              >
                Find a person
              </button>
            </div>
          ) : visibleConversations.length > 0 ? (
            visibleConversations.map((conversation) => (
              <button
                key={conversation.id}
                className={`conversation-item ${activeId === conversation.id ? "is-selected" : ""}`}
                onClick={() => selectConversation(conversation)}
                aria-current={activeId === conversation.id ? "page" : undefined}
              >
                <span className="conversation-avatar-wrap">
                  <Avatar
                    name={conversation.name}
                    tone={conversation.tone}
                    online={!conversation.group && conversation.online}
                  />
                  {conversation.group && (
                    <span className="group-mini-icon"><Users size={10} /></span>
                  )}
                </span>
                <span className="conversation-item__body">
                  <span className="conversation-item__top">
                    <span className="conversation-name">{conversation.name}</span>
                    <span className="conversation-time">{conversation.time}</span>
                  </span>
                  <span className="conversation-item__bottom">
                    <span className="conversation-preview">{conversation.lastMessage}</span>
                    {conversation.unread > 0 && (
                      <span className="unread-badge" aria-label={`${conversation.unread} unread messages`}>
                        {conversation.unread}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            ))
          ) : (
            <div className="empty-search">
              <span className="empty-search__icon"><Search size={18} /></span>
              <strong>No conversations found</strong>
              <span>Try another name or filter.</span>
            </div>
          )}
          {conversationsHasMore && !conversationsLoading && (
            <button
              type="button"
              className="auth-refined__switch"
              onClick={loadMoreConversations}
              disabled={loadingMoreConversations}
            >
              {loadingMoreConversations ? "Loading…" : "Load more conversations"}
            </button>
          )}
        </div>

        <div className="sidebar-footer">
          <span className="secure-indicator"><span /> Your conversations are private</span>
        </div>
      </aside>

      <section
        className="chat-panel"
        aria-label={
          activeConversation.id
            ? `Conversation with ${activeConversation.name}`
            : "Messages"
        }
      >
        {activeConversation.id ? (
          <>
        <header className="chat-header">
          <button
            className="mobile-back icon-button"
            onClick={() => {
              setMobileChatOpen(false);
              setDetailsOpen(false);
            }}
            aria-label="Back to conversations"
          >
            <ArrowLeft size={20} />
          </button>
          <button className="chat-contact" onClick={() => activeConversation.group && setDetailsOpen((open) => !open)}>
            <span className="header-avatar-wrap">
              <Avatar
                name={activeConversation.name}
                tone={activeConversation.tone}
                size="regular"
                online={!activeConversation.group && activeConversation.online}
              />
            </span>
            <span className="chat-contact__copy">
              <span className="chat-contact__name">{activeConversation.name}</span>
              <span className={`chat-contact__status ${activeConversation.online && !activeConversation.group ? "is-online" : ""}`}>
                {activeConversation.group ? (
                  <><span className="status-dot status-dot--muted" />{activeConversation.memberCount} members</>
                ) : (
                  <><span className={`status-dot ${activeConversation.online ? "" : "status-dot--muted"}`} />{activeConversation.online ? "Online now" : activeConversation.subtitle}</>
                )}
              </span>
            </span>
            {activeConversation.group && <ChevronDown className="contact-chevron" size={15} />}
          </button>
          <div className="chat-header__actions">
            <button
              type="button"
              className="icon-button call-header-button call-action"
              onClick={() => void calling.startCall(activeConversation.id, "AUDIO")}
              disabled={Boolean(calling.call || calling.incomingCall)}
              aria-label="Start audio call"
              title="Audio call"
            >
              <Phone size={18} />
            </button>
            <button
              type="button"
              className="icon-button call-header-button call-action"
              onClick={() => void calling.startCall(activeConversation.id, "VIDEO")}
              disabled={Boolean(calling.call || calling.incomingCall)}
              aria-label="Start video call"
              title="Video call"
            >
              <Video size={18} />
            </button>
            <button className={`icon-button ${detailsOpen ? "is-pressed" : ""}`} onClick={() => setDetailsOpen((open) => !open)} aria-label="Conversation details" aria-expanded={detailsOpen}>
              <Info size={19} />
            </button>
            <button className="icon-button mobile-more" onClick={() => setDetailsOpen((open) => !open)} aria-label="More conversation options">
              <MoreHorizontal size={20} />
            </button>
          </div>
        </header>

        <div className="conversation-content">
          <div className="day-divider"><span>MESSAGES</span></div>
          <div className="message-list" aria-live="polite">
            {hasOlderMessages && (
              <button
                type="button"
                className="auth-refined__switch"
                onClick={loadOlderMessages}
                disabled={olderMessagesLoading}
              >
                {olderMessagesLoading ? "Loading…" : "Load older messages"}
              </button>
            )}
            {messagesLoading && (
              <div className="empty-search" role="status">Loading messages…</div>
            )}
            {!messagesLoading && activeConversation.messages.length === 0 && (
              <div className="empty-search">
                <strong>No messages yet</strong>
                <span>Send a message to start the conversation.</span>
              </div>
            )}
            {activeConversation.messages.map((message, index) => {
              const previous = activeConversation.messages[index - 1];
              const showAuthor = activeConversation.group && message.sender === "other" && message.author && previous?.author !== message.author;
              return (
                <div key={message.id} className={`message-row ${message.sender === "me" ? "message-row--mine" : ""}`}>
                  {message.sender === "other" && activeConversation.group && (
                    showAuthor ? (
                      <Avatar name={message.author ?? activeConversation.name} tone={activeConversation.members.find((member) => member.name.startsWith(message.author ?? ""))?.tone ?? "violet"} size="small" />
                    ) : <span className="message-avatar-spacer" />
                  )}
                  <div className="message-body">
                    {showAuthor && <span className="message-author">{message.author}</span>}
                    {editingMessageId === message.id ? (
                      <form className="message-edit-form" onSubmit={saveMessageEdit}>
                        <label className="visually-hidden" htmlFor={`edit-message-${message.id}`}>Edit message</label>
                        <textarea
                          id={`edit-message-${message.id}`}
                          value={editingMessageText}
                          onChange={(event) => setEditingMessageText(event.target.value)}
                          maxLength={8000}
                          rows={2}
                          autoFocus
                        />
                        <button type="submit" disabled={!editingMessageText.trim() || messageMutationId === message.id}>Save</button>
                        <button type="button" onClick={() => setEditingMessageId(null)}>Cancel</button>
                      </form>
                    ) : (
                      <>
                        <div className="message-line">
                          <div className={`message-bubble ${message.deleted ? "message-bubble--deleted" : ""}`}>
                            {message.text}
                            {message.edited && !message.deleted && <span className="message-edited"> · edited</span>}
                          </div>
                          <span className="message-time">
                            {message.time}
                            {message.sender === "me" && !message.deleted && (
                              message.read ? <CheckCheck size={14} className="read-receipt" aria-label="Read" /> : <Check size={14} />
                            )}
                          </span>
                        </div>
                        {message.sender === "me" && !message.deleted && (
                          <div className="message-actions">
                            <button
                              type="button"
                              aria-label="Edit message"
                              onClick={() => {
                                setEditingMessageId(message.id);
                                setEditingMessageText(message.text);
                              }}
                            >
                              <Pencil size={13} />
                            </button>
                            <button
                              type="button"
                              aria-label="Delete message"
                              onClick={() => void deleteMessage(message.id)}
                              disabled={messageMutationId === message.id}
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        </div>

        <footer className="composer-wrap">
          {notice && <div className="composer-notice" role="status">{notice}</div>}
          <form className="message-composer" onSubmit={sendMessage}>
            <input
              className="composer-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={`Message ${activeConversation.group ? activeConversation.name : activeConversation.name.split(" ")[0]}...`}
              aria-label="Write a message"
            />
            <button type="button" className="composer-icon composer-emoji" aria-label="Add emoji" onClick={() => setDraft((text) => `${text}${text ? " " : ""}🙂`)}>
              <Smile size={19} />
            </button>
            <button type="submit" className="send-button" disabled={!draft.trim() || sending} aria-label="Send message">
              <Send size={17} />
            </button>
          </form>
          <div className="composer-hint">Press <kbd>Enter</kbd> to send <span>·</span> Keep it kind, keep it human.</div>
        </footer>
          </>
        ) : (
          <div className="conversation-empty-state">
            <MessageCircle size={25} aria-hidden="true" />
            <h2>
              {conversationsLoading
                ? "Loading your conversations"
                : conversationsError
                  ? "Conversations are unavailable"
                  : "Your conversations start here."}
            </h2>
            <p>
              {conversationsError ||
                "Choose a conversation or find someone to start a new one."}
            </p>
            {!conversationsLoading && (
              <button
                type="button"
                className="auth-submit auth-refined__submit"
                onClick={() =>
                  conversationsError
                    ? retryConversations()
                      : openNewConversation()
                }
              >
                {conversationsError ? "Try again" : "Find a person"}
                <ArrowLeft size={16} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </section>

      {detailsOpen && activeConversation.id && (
        <aside className="details-panel" aria-label="Conversation details">
          <div className="details-panel__header">
            <h2>{activeConversation.group ? "Group details" : "Contact info"}</h2>
            <button className="icon-button" onClick={() => setDetailsOpen(false)} aria-label="Close conversation details"><X size={18} /></button>
          </div>
          <div className="details-profile">
            <Avatar name={activeConversation.name} tone={activeConversation.tone} size="large" online={!activeConversation.group && activeConversation.online} />
            <strong>{activeConversation.name}</strong>
            <span>{activeConversation.group ? `${activeConversation.memberCount} members` : activeConversation.subtitle}</span>
          </div>
          {!activeConversation.group && (
            <div className="details-note"><span className="status-dot" />{activeConversation.online ? "Online now" : "Last active recently"}</div>
          )}
          <div className="details-section">
            <div className="details-section__heading">
              <span>{activeConversation.group ? "People" : "Shared space"}</span>
              {activeConversation.group &&
                activeConversation.members.some(
                  (member) =>
                    member.id === user.id &&
                    (member.role === "OWNER" || member.role === "ADMIN"),
                ) && (
                  <button
                    className="text-icon-button"
                    aria-label="Add a member"
                    onClick={openAddParticipant}
                  >
                    <Plus size={16} />
                  </button>
                )}
            </div>
            {activeConversation.group ? activeConversation.members.map((member) => (
              <div className="member-row" key={member.name}>
                <Avatar name={member.name} tone={member.tone} size="small" online={member.status === "Active now"} />
                <span className="member-row__copy"><strong>{member.name}</strong><small>{member.role.toLowerCase()}</small></span>
                {member.id === user.id ? (
                  <span className="you-tag">YOU</span>
                ) : activeConversation.members.some(
                    (actor) =>
                      actor.id === user.id &&
                      (actor.role === "OWNER" || actor.role === "ADMIN"),
                  ) && member.role !== "OWNER" ? (
                  <button
                    type="button"
                    className="text-icon-button"
                    aria-label={`Remove ${member.name}`}
                    onClick={() => void removeGroupParticipant(member.id)}
                    disabled={groupBusy}
                  >
                    <X size={15} />
                  </button>
                ) : null}
              </div>
            )) : (
              <div className="shared-note">
                <span className="shared-note__icon"><ImageIcon size={17} /></span>
                <span><strong>Photos & files</strong><small>Nothing shared just yet</small></span>
                <ChevronRight size={16} />
              </div>
            )}
          </div>
          <div className="details-section details-section--bottom">
            {activeConversation.group &&
              activeConversation.members.some(
                (member) =>
                  member.id === user.id &&
                  (member.role === "OWNER" || member.role === "ADMIN"),
              ) && (
                <div className="group-name-editor">
                  {groupNameEditing ? (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void updateGroupName();
                      }}
                    >
                      <label htmlFor="group-name-edit">Group name</label>
                      <input
                        id="group-name-edit"
                        value={groupNameDraft}
                        onChange={(event) => setGroupNameDraft(event.target.value)}
                        maxLength={100}
                        required
                      />
                      <button type="submit" disabled={groupBusy}>Save name</button>
                      <button type="button" onClick={() => setGroupNameEditing(false)}>Cancel</button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      className="details-action"
                      onClick={() => {
                        setGroupNameDraft(activeConversation.name);
                        setGroupNameEditing(true);
                      }}
                    >
                      Rename group
                    </button>
                  )}
                </div>
              )}
            {activeConversation.group && (
              <button
                type="button"
                className="details-action"
                onClick={() => void leaveGroup()}
                disabled={groupBusy}
              >
                Leave group
              </button>
            )}
          </div>
        </aside>
      )}

      {profileOpen && (
        <>
          <button className="dismiss-layer" onClick={() => setProfileOpen(false)} aria-label="Close profile menu" />
          <div className="profile-menu">
            <div className="profile-menu__person">
              <Avatar name={profileName} tone="me" size="regular" online />
              <span><strong>{profileName}</strong><small>{user.email}</small></span>
            </div>
            <span className="profile-menu__status"><span />Available</span>
            <button type="button" onClick={() => void openProfileEditor()} disabled={profileSaving}>
              <Pencil size={16} />Edit profile<ChevronRight size={15} />
            </button>
            <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
              Switch to {theme === "dark" ? "light" : "dark"} theme
              <ChevronRight size={15} />
            </button>
            <span className="profile-menu__divider" />
            <button onClick={onLogout}><LogOut size={16} />Sign out<ChevronRight size={15} /></button>
          </div>
        </>
      )}

      {newConversationOpen && (
        <div className="conversation-dialog-backdrop">
          <section
            className="conversation-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-conversation-title"
          >
            <header>
              <div>
                <span className="eyebrow">PINGTALK</span>
                <h2 id="new-conversation-title">
                  {newConversationMode === "add"
                    ? "Add people"
                    : newConversationMode === "group"
                      ? "Create a group"
                      : "Start a conversation"}
                </h2>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setNewConversationOpen(false)}
                aria-label="Close new conversation dialog"
              >
                <X size={18} />
              </button>
            </header>
            {newConversationMode !== "add" && (
              <div className="conversation-dialog__tabs" role="tablist" aria-label="Conversation type">
                <button
                  type="button"
                  role="tab"
                  aria-selected={newConversationMode === "private"}
                  onClick={() => setNewConversationMode("private")}
                >
                  Private
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={newConversationMode === "group"}
                  onClick={() => setNewConversationMode("group")}
                >
                  Group
                </button>
              </div>
            )}
            {newConversationMode === "group" && (
              <label className="conversation-dialog__group-name">
                <span>Group name</span>
                <input
                  value={groupName}
                  onChange={(event) => setGroupName(event.target.value)}
                  placeholder="Name your group"
                  maxLength={100}
                  required
                />
              </label>
            )}
            <label className="search-field">
              <Search size={17} aria-hidden="true" />
              <input
                type="search"
                autoFocus
                value={userSearch}
                onChange={(event) => setUserSearch(event.target.value)}
                placeholder="Search by name or email"
                aria-label="Search users by name or email"
              />
            </label>
            <div className="conversation-dialog__results" aria-live="polite">
              {userSearch.length < 2 ? (
                <p>Enter at least 2 characters to find people.</p>
              ) : userSearchState.query !== userSearch.trim() ||
                userSearchState.loading ? (
                <p role="status">Searching…</p>
              ) : userSearchState.error ? (
                <p role="alert">{userSearchState.error}</p>
              ) : eligibleSearchUsers.length === 0 ? (
                <p>
                  {newConversationMode === "add" && userSearchState.users.length
                    ? "Everyone in these results is already in this group."
                    : "No people found."}
                </p>
              ) : (
                eligibleSearchUsers.map((result, index) =>
                    newConversationMode === "group" ? (
                      <label className="conversation-dialog__user" key={result.id}>
                        <input
                          type="checkbox"
                          checked={selectedParticipantIds.includes(result.id)}
                          onChange={(event) =>
                            setSelectedParticipantIds((current) =>
                              event.target.checked
                                ? [...current, result.id]
                                : current.filter((id) => id !== result.id),
                            )
                          }
                        />
                        <Avatar
                          name={result.name}
                          tone={avatarTones[index % avatarTones.length]}
                          size="small"
                        />
                        <span>{result.name}</span>
                      </label>
                    ) : (
                      <button
                        type="button"
                        key={result.id}
                        onClick={() =>
                          newConversationMode === "add"
                            ? void addGroupParticipant(result.id)
                            : void startPrivateConversation(result.id)
                        }
                        disabled={creatingConversation || groupBusy}
                      >
                        <Avatar
                          name={result.name}
                          tone={avatarTones[index % avatarTones.length]}
                          size="small"
                        />
                        <span>{result.name}</span>
                        <ChevronRight size={16} aria-hidden="true" />
                      </button>
                    ),
                  )
              )}
              {userSearchState.hasMore && userSearchState.query === userSearch.trim() && (
                <button
                  type="button"
                  className="conversation-dialog__load-more"
                  onClick={() => void loadMoreUsers()}
                  disabled={userSearchState.loading}
                >
                  {userSearchState.loading ? "Loading…" : "Load more people"}
                </button>
              )}
            </div>
            {newConversationMode === "group" && (
              <button
                type="button"
                className="auth-submit auth-refined__submit"
                onClick={() => void createGroupConversation()}
                disabled={
                  groupBusy ||
                  !groupName.trim() ||
                  selectedParticipantIds.length === 0
                }
              >
                {groupBusy
                  ? "Creating group…"
                  : `Create group${selectedParticipantIds.length ? ` · ${selectedParticipantIds.length}` : ""}`}
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            )}
          </section>
        </div>
      )}

      {profileEditorOpen && (
        <div className="conversation-dialog-backdrop">
          <section
            className="conversation-dialog profile-editor"
            role="dialog"
            aria-modal="true"
            aria-labelledby="profile-editor-title"
          >
            <header>
              <div>
                <span className="eyebrow">YOUR PROFILE</span>
                <h2 id="profile-editor-title">Edit profile</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setProfileEditorOpen(false)}
                aria-label="Close profile editor"
              >
                <X size={18} />
              </button>
            </header>
            <form onSubmit={saveProfile}>
              <label className="conversation-dialog__group-name">
                <span>Display name</span>
                <input
                  value={profileNameDraft}
                  onChange={(event) => setProfileNameDraft(event.target.value)}
                  minLength={2}
                  maxLength={120}
                  required
                />
              </label>
              <label className="conversation-dialog__group-name">
                <span>Status message</span>
                <input
                  value={profileStatusDraft}
                  onChange={(event) => setProfileStatusDraft(event.target.value)}
                  maxLength={160}
                  placeholder="A little about you"
                />
              </label>
              {notice && <p role="alert">{notice}</p>}
              <button
                type="submit"
                className="auth-submit auth-refined__submit"
                disabled={profileSaving || profileNameDraft.trim().length < 2}
              >
                {profileSaving ? "Saving…" : "Save profile"}
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </form>
          </section>
        </div>
      )}

      <CallingUI calling={calling} />

      <div className="mobile-bottom-nav" aria-label="Mobile navigation">
        <button className="is-active" onClick={() => setMobileChatOpen(false)}><MessageCircle size={19} /><span>Chats</span></button>
        <button onClick={openSearch}><Search size={19} /><span>Search</span></button>
        <button onClick={() => setProfileOpen((open) => !open)}><Avatar name={profileName} tone="me" size="small" /><span>You</span></button>
      </div>
    </main>
  );
}
