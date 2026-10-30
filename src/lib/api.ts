const apiBaseUrl =
  process.env.NEXT_PUBLIC_API_URL ??
  (process.env.NODE_ENV === "development" ? "http://localhost:5000" : undefined);

if (!apiBaseUrl) {
  throw new Error("NEXT_PUBLIC_API_URL must be configured for the frontend.");
}

const apiUrl = apiBaseUrl.replace(/\/+$/, "");

function getApiRequestUrl(path: string) {
  if (typeof window !== "undefined") return `/api${path}`;
  return `${apiUrl}/api${path}`;
}

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

export const PROFILE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const PROFILE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function uploadProfileImage(
  file: File,
  onProgress: (progress: number) => void,
): Promise<{ user: ApiUser }> {
  if (!PROFILE_IMAGE_TYPES.has(file.type)) {
    throw new ApiError("Choose a JPEG, PNG, or WebP image.", 415, "UNSUPPORTED_IMAGE_TYPE");
  }
  if (file.size === 0 || file.size > PROFILE_IMAGE_MAX_BYTES) {
    throw new ApiError(
      file.size === 0 ? "The selected image is empty." : "Profile images must be 5 MB or smaller.",
      file.size === 0 ? 400 : 413,
      file.size === 0 ? "EMPTY_IMAGE" : "PAYLOAD_TOO_LARGE",
    );
  }

  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", getApiRequestUrl("/me/image"));
    request.withCredentials = true;
    request.timeout = 60_000;
    request.setRequestHeader("Content-Type", file.type);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      }
    };
    request.onerror = () => {
      reject(new ApiError(
        "Unable to reach PingTalk. Check your connection and try again.",
        0,
        "NETWORK_ERROR",
      ));
    };
    request.ontimeout = () => {
      reject(new ApiError("The upload timed out. Please try again.", 0, "UPLOAD_TIMEOUT"));
    };
    request.onload = () => {
      let payload: { user?: ApiUser; error?: { code?: string; message?: string } };
      try {
        payload = JSON.parse(request.responseText) as typeof payload;
      } catch {
        reject(new ApiError(
          "The server returned an unexpected response.",
          request.status,
          "INVALID_RESPONSE",
        ));
        return;
      }
      if (request.status < 200 || request.status >= 300 || !payload.user) {
        if (request.status === 401 && typeof window !== "undefined") {
          window.dispatchEvent(new Event("pingtalk:unauthorized"));
        }
        reject(new ApiError(
          payload.error?.message ?? "The upload could not be completed.",
          request.status,
          payload.error?.code ?? "REQUEST_FAILED",
        ));
        return;
      }
      onProgress(100);
      resolve({ user: payload.user });
    };
    request.send(file);
  });
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
    response = await fetch(getApiRequestUrl(path), {
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
  reactions: Array<{ userId: string; emoji: string }>;
};
