"use strict";

const primary = document.getElementById("primary");
const replica = document.getElementById("replica");
const links = document.getElementById("cabinet-links");

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
    const replicaCheck = readyAddress(replica, controller.signal).catch(() => null);
    try {
        const address = (await primaryCheck) ?? (await replicaCheck);
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
