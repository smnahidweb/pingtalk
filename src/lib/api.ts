const apiBaseUrl =
  process.env.NEXT_PUBLIC_API_URL ??
  (process.env.NODE_ENV === "development" ? "http://localhost:5000" : undefined);

if (!apiBaseUrl) {
  throw new Error("NEXT_PUBLIC_API_URL must be configured for the frontend.");
}

const apiUrl = apiBaseUrl.replace(/\/+$/, "");

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type ApiErrorResponse = {
  error?: {
    code?: string;
    message?: string;
  };
};

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/api${path}`, {
      ...init,
      credentials: "include",
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError(
      "Unable to reach PingTalk. Check your connection and try again.",
      0,
      "NETWORK_ERROR",
    );
  }

  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new Event("pingtalk:unauthorized"));
    }
    let payload: ApiErrorResponse | undefined;
    try {
      payload = (await response.json()) as ApiErrorResponse;
    } catch {
      throw new ApiError(
        "The server returned an unexpected response.",
        response.status,
        "INVALID_RESPONSE",
      );
    }
    throw new ApiError(
      payload.error?.message ?? "The request could not be completed.",
      response.status,
      payload.error?.code ?? "REQUEST_FAILED",
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export type ApiConversation = {
  id: string;
  type: "PRIVATE" | "GROUP";
  title: string;
  updatedAt: string;
  memberCount: number;
  unreadCount: number;
  lastMessage: {
    id: string;
    content: string;
    createdAt: string;
    senderId: string;
    senderName: string;
  } | null;
  members: Array<{
    id: string;
    name: string;
    image: string | null;
    role: "OWNER" | "ADMIN" | "MEMBER";
  }>;
};

export type ApiUser = {
  id: string;
  name: string;
  image: string | null;
};

export type ApiMessage = {
  id: string;
  content: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  sender: { id: string; name: string; image: string | null };
  read: boolean;
};
