"use strict";

const primary = document.getElementById("primary");
const replica = document.getElementById("replica");
const links = document.getElementById("cabinet-links");
const emergencyOrigin = document.querySelector('meta[name="emergency-origin"]')?.content;

async function activeEmergency(signal) {
    if (!emergencyOrigin) return null;
    const controller = new URL(emergencyOrigin);
    if (controller.protocol !== "https:") return null;
    const response = await fetch(new URL("/status", controller), {
        cache: "no-store", credentials: "omit", redirect: "error", signal,
    });
    if (response.status !== 200) return null;
    const state = await response.json();
    if (state.status !== "ready" || !Number.isFinite(state.until) || state.until <= Date.now()
        || typeof state.url !== "string") return null;
    const address = new URL(state.url);
    if (address.protocol !== "https:" || address.username || address.password || address.pathname !== "/"
        || address.search || address.hash) return null;
    return address.href;
}

async function readyAddress(link, signal) {
    const response = await fetch(new URL("/health", link.href), {
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal,
    });
    if (response.status !== 200 || (await response.json()).status !== "ok") {
        throw new Error("Cabinet unavailable");
    }
    return link.href;
}

async function connect() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const primaryCheck = readyAddress(primary, controller.signal).catch(() => null);
    const replicaCheck = replica ? readyAddress(replica, controller.signal).catch(() => null) : null;
    const emergencyCheck = activeEmergency(controller.signal).catch(() => null);
    try {
        const address = (await emergencyCheck) ?? (await primaryCheck) ?? (await replicaCheck);
        if (address) {
            window.location.replace(address);
        } else {
            links.hidden = false;
        }
    } finally {
        clearTimeout(timeout);
        controller.abort();
    }
}

void connect();
