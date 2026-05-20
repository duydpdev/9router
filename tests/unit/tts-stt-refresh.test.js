import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  checkAndRefreshToken: vi.fn(),
  handleTtsCore: vi.fn(),
  handleSttCore: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  extractApiKey: vi.fn(() => "k"),
  isValidApiKey: vi.fn(async () => true),
  getSettings: vi.fn(async () => ({ requireApiKey: false })),
  getModelInfo: vi.fn(async () => ({ provider: "openai", model: "tts-1" })),
  getComboModels: vi.fn(async () => null),
  handleComboChat: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: mocks.extractApiKey,
  isValidApiKey: mocks.isValidApiKey,
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
}));

vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));

vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));

vi.mock("open-sse/handlers/ttsCore.js", () => ({ handleTtsCore: mocks.handleTtsCore }));
vi.mock("open-sse/handlers/sttCore.js", () => ({ handleSttCore: mocks.handleSttCore }));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
}));

vi.mock("open-sse/services/combo.js", () => ({ handleComboChat: mocks.handleComboChat }));

vi.mock("@/shared/constants/providers", () => ({
  AI_PROVIDERS: {
    openai: {
      serviceKinds: ["tts", "stt"],
      ttsConfig: { authType: "bearer" },
      sttConfig: { authType: "bearer", format: "openai" },
    },
  },
}));

const { handleTts } = await import("../../src/sse/handlers/tts.js");
const { handleStt } = await import("../../src/sse/handlers/stt.js");

function ttsRequest(body) {
  return {
    url: "http://localhost/v1/audio/speech",
    json: async () => body,
  };
}

function sttRequest(formData) {
  return {
    url: "http://localhost/v1/audio/transcriptions",
    formData: async () => formData,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({ requireApiKey: false });
  mocks.getComboModels.mockResolvedValue(null);
  mocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "tts-1" });
});

describe("tts handler — proactive refresh", () => {
  it("calls checkAndRefreshToken between getProviderCredentials and handleTtsCore", async () => {
    const expired = {
      connectionId: "c1",
      connectionName: "old",
      authType: "oauth",
      accessToken: "stale",
      refreshToken: "rt",
      expiresAt: new Date(Date.now() - 60000).toISOString(),
    };
    const refreshed = { ...expired, connectionName: "fresh", accessToken: "fresh-token" };
    mocks.getProviderCredentials.mockResolvedValue(expired);
    mocks.checkAndRefreshToken.mockResolvedValue(refreshed);
    mocks.handleTtsCore.mockResolvedValue({ success: true, response: new Response("ok") });

    const res = await handleTts(ttsRequest({ model: "openai/tts-1", input: "hello" }));
    expect(mocks.checkAndRefreshToken).toHaveBeenCalledWith("openai", expired);
    expect(mocks.handleTtsCore).toHaveBeenCalledTimes(1);
    expect(mocks.handleTtsCore.mock.calls[0][0].credentials).toBe(refreshed);
    expect(await res.text()).toBe("ok");
  });

  it("falls back to original credentials when checkAndRefreshToken throws", async () => {
    const creds = {
      connectionId: "c1",
      connectionName: "n",
      authType: "oauth",
      accessToken: "at",
    };
    mocks.getProviderCredentials.mockResolvedValue(creds);
    mocks.checkAndRefreshToken.mockRejectedValue(new Error("network blip"));
    mocks.handleTtsCore.mockResolvedValue({ success: true, response: new Response("ok") });

    const res = await handleTts(ttsRequest({ model: "openai/tts-1", input: "hi" }));
    expect(mocks.handleTtsCore).toHaveBeenCalledTimes(1);
    expect(mocks.handleTtsCore.mock.calls[0][0].credentials).toBe(creds);
    expect(await res.text()).toBe("ok");
  });
});

describe("stt handler — proactive refresh", () => {
  it("calls checkAndRefreshToken between getProviderCredentials and handleSttCore", async () => {
    const expired = {
      connectionId: "c1",
      connectionName: "old",
      authType: "oauth",
      accessToken: "stale",
      refreshToken: "rt",
      expiresAt: new Date(Date.now() - 60000).toISOString(),
    };
    const refreshed = { ...expired, connectionName: "fresh", accessToken: "fresh-token" };
    mocks.getProviderCredentials.mockResolvedValue(expired);
    mocks.checkAndRefreshToken.mockResolvedValue(refreshed);
    mocks.handleSttCore.mockResolvedValue({ success: true, response: new Response("ok") });

    const fd = new FormData();
    fd.append("model", "openai/whisper-1");
    fd.append("file", new Blob(["x"], { type: "audio/wav" }), "x.wav");
    const res = await handleStt(sttRequest(fd));

    expect(mocks.checkAndRefreshToken).toHaveBeenCalledWith("openai", expired);
    expect(mocks.handleSttCore).toHaveBeenCalledTimes(1);
    expect(mocks.handleSttCore.mock.calls[0][0].credentials).toBe(refreshed);
    expect(await res.text()).toBe("ok");
  });

  it("falls back to original credentials when checkAndRefreshToken throws", async () => {
    const creds = {
      connectionId: "c1",
      connectionName: "n",
      authType: "oauth",
      accessToken: "at",
    };
    mocks.getProviderCredentials.mockResolvedValue(creds);
    mocks.checkAndRefreshToken.mockRejectedValue(new Error("blip"));
    mocks.handleSttCore.mockResolvedValue({ success: true, response: new Response("ok") });

    const fd = new FormData();
    fd.append("model", "openai/whisper-1");
    fd.append("file", new Blob(["x"], { type: "audio/wav" }), "x.wav");
    const res = await handleStt(sttRequest(fd));
    expect(mocks.handleSttCore.mock.calls[0][0].credentials).toBe(creds);
    expect(await res.text()).toBe("ok");
  });
});
