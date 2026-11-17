"use strict";

const form = document.getElementById("launch");
const fields = document.getElementById("launch-fields");
const status = document.getElementById("status");
const feedback = document.getElementById("launch-feedback");
const configuredOrigin = document.querySelector('meta[name="emergency-origin"]').content;
const labels = {
    idle: "Резерв выключен.", ordering: "Заказываем VPS.", provision: "Устанавливаем резервный кабинет.",
    ready: "Резерв готов.", cleaning: "Удаляем временный VPS.", uncertain: "Проверяем состояние заказа в Aeza.",
    rejected: "Aeza отклонила заказ.", finished: "Временный VPS удалён.",
};
const dateFormat = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Moscow" });
const idle = new Set(["idle", "finished", "rejected"]);
let submitting = false;

async function call(controller, path, body) {
    const target = controller.hostname === "functions.yandexcloud.net" ? new URL(controller) : new URL(path, controller);
    if (target.hostname === "functions.yandexcloud.net") target.searchParams.set("route", path.slice(1));
    return fetch(target, {
        method: body ? "POST" : "GET", body, credentials: "omit", cache: "no-store", redirect: "error",
        signal: AbortSignal.timeout(10000),
    });
}

function show(state) {
    const end = !idle.has(state.status) && Number.isFinite(state.until)
        ? ` Срок аренды до ${dateFormat.format(state.until)} МСК.` : "";
    status.textContent = (labels[state.status] ?? "Статус резерва неизвестен.") + end;
    fields.disabled = !idle.has(state.status) || submitting;
}

function error(message) {
    feedback.textContent = message;
    feedback.hidden = !message;
}

function run() {
    if (location.origin !== "https://arcpass.github.io" || !configuredOrigin.startsWith("https://")) {
        status.textContent = "Контроллер резерва ещё не подключён.";
        return;
    }
    const controller = new URL(configuredOrigin);
    let refreshSequence = 0;
    async function refresh() {
        const sequence = ++refreshSequence;
        try {
            const response = await call(controller, "/status");
            if (!response.ok) throw new Error();
            const state = await response.json();
            if (sequence === refreshSequence) show(state);
        } catch {
            if (sequence !== refreshSequence) return;
            status.textContent = "Контроллер резерва недоступен. Повторяем проверку…";
            fields.disabled = true;
        }
    }

    form.addEventListener("submit", async event => {
        event.preventDefault();
        if (submitting || fields.disabled) return;
        const body = new URLSearchParams(new FormData(form));
        form.elements.password.value = "";
        submitting = true;
        refreshSequence += 1;
        fields.disabled = true;
        error("");
        try {
            const response = await call(controller, "/launch", body);
            if (response.status === 403) error("Проверьте пароль запуска.");
            else if (response.status === 429) error("Слишком много попыток. Повторите через минуту.");
            else if (response.status !== 202) error("Контроллер не принял запрос. Проверьте настройки и повторите попытку.");
        } catch {
            error("Статус запуска неизвестен. Дождитесь обновления перед повторной попыткой.");
        } finally {
            submitting = false;
            await refresh();
        }
    });
    void refresh();
    setInterval(refresh, 5000);
}

run();
