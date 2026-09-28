import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createPhase9bRealtimeRequestGate,
  type Phase9bBudgetReservationClient,
  type Phase9bHeadersReceivedDetails,
  type Phase9bWebRequestDetails,
  type Phase9bWebRequestSession
} from "./phase9b-live-budget.js";

type Listener = (
  details: Phase9bWebRequestDetails,
  callback: (response: { cancel?: boolean }) => void
) => void;

type HeadersListener = (
  details: Phase9bHeadersReceivedDetails,
  callback: (response: { cancel?: boolean }) => void
) => void;

function session(): {
  surface: Phase9bWebRequestSession;
  listener: () => Listener;
  headersListener: () => HeadersListener;
  urls: () => string[];
  headersUrls: () => string[];
} {
  let registered: Listener | undefined;
  let registeredHeaders: HeadersListener | undefined;
  let registeredUrls: string[] = [];
  let registeredHeadersUrls: string[] = [];
  const surface: Phase9bWebRequestSession = {
    webRequest: {
      onBeforeRequest(filter, listener) {
        registeredUrls = filter.urls;
        registered = listener;
      },
      onHeadersReceived(filter, listener) {
        registeredHeadersUrls = filter.urls;
        registeredHeaders = listener;
      }
    }
  };
  return {
    surface,
    listener: () => {
      assert.ok(registered);
      return registered;
    },
    headersListener: () => {
      assert.ok(registeredHeaders);
      return registeredHeaders;
    },
    urls: () => registeredUrls,
    headersUrls: () => registeredHeadersUrls
  };
}

function invoke(
  listener: Listener,
  details: Phase9bWebRequestDetails
): Promise<{ cancel?: boolean }> {
  return new Promise(resolve => listener(details, resolve));
}

function invokeHeaders(
  listener: HeadersListener,
  details: Phase9bHeadersReceivedDetails
): Promise<{ cancel?: boolean }> {
  return new Promise(resolve => listener(details, resolve));
}

test("live Realtime gate filters the exact Azure call and reserves both budgets", async () => {
  const requests: Array<{ kind: string; logicalId: string; requestKey: string }> = [];
  const reserve: Phase9bBudgetReservationClient = async (kind, logicalId, requestKey) => {
    requests.push({ kind, logicalId, requestKey });
  };
  const current = session();
  const trustedEndpoint = "https://resource.openai.azure.com/openai/v1/realtime/calls";
  createPhase9bRealtimeRequestGate(reserve, trustedEndpoint).attach(current.surface);
  const listener = current.listener();

  assert.deepEqual(await invoke(listener, {
    method: "GET",
    url: trustedEndpoint
  }), { cancel: true });
  assert.deepEqual(await invoke(listener, {
    method: "POST",
    url: "https://openai.azure.com/openai/v1/realtime/calls"
  }), {});
  assert.deepEqual(await invoke(listener, {
    method: "POST",
    url: "https://resource.openai.azure.com:8443/openai/v1/realtime/calls"
  }), {});
  assert.deepEqual(await invoke(listener, {
    method: "POST",
    url: trustedEndpoint
  }), {});
  assert.deepEqual(await invoke(listener, {
    method: "POST",
    url: trustedEndpoint
  }), {});
  assert.deepEqual(await invoke(listener, {
    method: "POST",
    url: `${trustedEndpoint}?unexpected=1`
  }), { cancel: true });
  assert.equal(requests.length, 4);
  assert.deepEqual(requests.map(request => request.kind), [
    "providerRequests",
    "realtimeConnections",
    "providerRequests",
    "realtimeConnections"
  ]);
  assert.equal(requests[0]!.logicalId, requests[1]!.logicalId);
  assert.notEqual(requests[0]!.logicalId, requests[2]!.logicalId);
  assert.notEqual(requests[0]!.requestKey, requests[1]!.requestKey);
  assert.deepEqual(current.urls(), ["https://resource.openai.azure.com/*"]);
  assert.deepEqual(current.headersUrls(), ["https://resource.openai.azure.com/*"]);
  assert.deepEqual(await invokeHeaders(current.headersListener(), {
    url: trustedEndpoint,
    statusCode: 200
  }), {});
  assert.deepEqual(await invokeHeaders(current.headersListener(), {
    url: trustedEndpoint,
    statusCode: 302
  }), { cancel: true });
  assert.deepEqual(await invokeHeaders(current.headersListener(), {
    url: "https://resource.openai.azure.com/redirected",
    statusCode: 302
  }), { cancel: true });
});

test("a denied reservation cancels the browser request before it reaches Azure", async () => {
  const requests: string[] = [];
  const current = session();
  createPhase9bRealtimeRequestGate(async kind => {
    requests.push(kind);
    throw new Error("fixture rejection");
  }, "https://resource.openai.azure.com/openai/v1/realtime/calls").attach(current.surface);

  const result = await invoke(current.listener(), {
    method: "POST",
    url: "https://resource.openai.azure.com/openai/v1/realtime/calls"
  });

  assert.deepEqual(result, { cancel: true });
  assert.deepEqual(requests, ["providerRequests"]);
});

test("the live budget exposes the bounded delegation reservation to Main IPC", async () => {
  const reservations: Array<{ kind: string; logicalId: string; requestKey: string }> = [];
  const gate = createPhase9bRealtimeRequestGate(async (kind, logicalId, requestKey) => {
    reservations.push({ kind, logicalId, requestKey });
  }, "https://resource.openai.azure.com/openai/v1/realtime/calls");
  const logicalId = "018f6f22-6c48-7c44-a3f5-1ef2f1d7e9b0";

  await gate.reserve("delegationAttempts", logicalId, `desktop-delegation:${logicalId}`);

  assert.deepEqual(reservations, [{
    kind: "delegationAttempts",
    logicalId,
    requestKey: `desktop-delegation:${logicalId}`
  }]);
});
