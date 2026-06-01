const STATUS_MAP = {
    "1": "Новая",
    "2": "Ждет выполнения",
    "3": "Выполняется",
    "4": "Ждет контроля",
    "5": "Завершена",
    "6": "Отложена",
    "7": "Отклонена"
};

function getWebhookUrl() {
    const webhook = process.env.BITRIX_WEBHOOK_URL || "";
    return webhook.endsWith("/") ? webhook : `${webhook}/`;
}

async function b24Call(method, params = {}) {
    const webhook = getWebhookUrl();
    if (!webhook) {
        throw new Error("BITRIX_WEBHOOK_URL is not configured");
    }

    const response = await fetch(`${webhook}${method}.json`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
        },
        body: JSON.stringify(params)
    });

    if (!response.ok) {
        throw new Error(`Bitrix request failed: ${response.status}`);
    }

    const data = await response.json();
    if (data.error) {
        throw new Error(data.error_description || data.error);
    }

    return data.result;
}

function pick(source, keys, fallback = "") {
    for (const key of keys) {
        const value = source?.[key];
        if (value !== undefined && value !== null && value !== "") {
            return value;
        }
    }

    return fallback;
}

function normalizeUserName(userId, embeddedUser) {
    if (embeddedUser && typeof embeddedUser === "object") {
        const name = [embeddedUser.name, embeddedUser.lastName].filter(Boolean).join(" ").trim();
        if (name) return name;
    }

    if (!userId) return "";
    return `Пользователь #${userId}`;
}

function normalizeTags(rawTags) {
    if (!rawTags) return [];

    if (typeof rawTags === "string") {
        return rawTags.split(",").map((tag) => tag.trim()).filter(Boolean);
    }

    if (Array.isArray(rawTags)) {
        return rawTags
            .map((tag) => {
                if (typeof tag === "string") return tag;
                if (tag && typeof tag === "object") {
                    return tag.name || tag.NAME || tag.title || "";
                }
                return "";
            })
            .map((tag) => String(tag).trim())
            .filter(Boolean);
    }

    if (typeof rawTags === "object") {
        return Object.values(rawTags)
            .map((tag) => {
                if (typeof tag === "string") return tag;
                if (tag && typeof tag === "object") {
                    return tag.name || tag.NAME || tag.title || "";
                }
                return "";
            })
            .map((tag) => String(tag).trim())
            .filter(Boolean);
    }

    return [];
}

function normalizeParticipants(rawList) {
    const list = Array.isArray(rawList)
        ? rawList
        : rawList && typeof rawList === "object"
            ? Object.values(rawList)
            : [];

    return list.map((item) => String(item)).filter(Boolean);
}

function normalizeChecklist(rawChecklist) {
    const items = Array.isArray(rawChecklist)
        ? rawChecklist
        : rawChecklist && typeof rawChecklist === "object"
            ? Object.values(rawChecklist)
            : [];

    return items.map((item) => ({
        id: pick(item, ["ID", "id"]),
        parentId: pick(item, ["PARENT_ID", "parentId"], "0"),
        title: pick(item, ["TITLE", "title"]),
        isComplete: pick(item, ["IS_COMPLETE", "isComplete"]) === "Y",
        isImportant: pick(item, ["IS_IMPORTANT", "isImportant"]) === "Y",
        sortIndex: Number(pick(item, ["SORT_INDEX", "sortIndex"], 0)) || 0
    }));
}

function normalizeMessages(rawMessages, rawUsers = {}, rawFiles = {}) {
    const messages = Array.isArray(rawMessages)
        ? rawMessages
        : rawMessages && typeof rawMessages === "object"
            ? Object.values(rawMessages)
            : [];

    const users = rawUsers && typeof rawUsers === "object" ? rawUsers : {};
    const files = rawFiles && typeof rawFiles === "object" ? rawFiles : {};

    return messages.map((message) => {
        const authorId = String(pick(message, ["author_id", "authorId", "AUTHOR_ID"], ""));
        const user = users[authorId] || users[Number(authorId)] || {};
        const authorName = [user.name, user.last_name, user.lastName]
            .filter(Boolean)
            .join(" ")
            .trim() || pick(message, ["authorName", "AUTHOR_NAME"], "Система");

        const fileIds = []
            .concat(message.files || [])
            .concat(message.FILE_ID || [])
            .filter(Boolean)
            .map((id) => String(id));

        return {
            id: pick(message, ["id", "ID"]),
            text: pick(message, ["text", "TEXT", "message", "MESSAGE"], ""),
            date: pick(message, ["date", "DATE", "PARAMS.DATE"], ""),
            authorId,
            authorName,
            isSystem: pick(message, ["system", "SYSTEM"], "N") === "Y",
            files: fileIds.map((id) => {
                const file = files[id] || {};
                return {
                    id,
                    name: pick(file, ["name", "NAME"], `Файл #${id}`),
                    url: pick(file, ["urlPreview", "urlShow", "urlDownload", "URL_DOWNLOAD"], "")
                };
            })
        };
    });
}

async function getTask(taskId) {
    const select = [
        "ID",
        "TITLE",
        "DESCRIPTION",
        "STATUS",
        "GROUP_ID",
        "GROUP_NAME",
        "CREATED_BY",
        "RESPONSIBLE_ID",
        "ACCOMPLICES",
        "AUDITORS",
        "DEADLINE",
        "CREATED_DATE",
        "CHANGED_DATE",
        "CLOSED_DATE",
        "TAGS",
        "CHAT_ID",
        "UF_CRM_TASK",
        "CREATOR",
        "RESPONSIBLE"
    ];

    try {
        const result = await b24Call("tasks.task.get", { taskId, select });
        return result?.task || result?.item || result;
    } catch (firstError) {
        const result = await b24Call("tasks.task.get", { id: taskId, select });
        return result?.task || result?.item || result;
    }
}

async function getChecklist(taskId) {
    try {
        const result = await b24Call("task.checklistitem.getlist", { TASKID: taskId });
        return normalizeChecklist(result);
    } catch (error) {
        return [];
    }
}

async function getChatMessages(chatId) {
    if (!chatId) {
        return [];
    }

    try {
        const result = await b24Call("im.dialog.messages.get", {
            DIALOG_ID: `chat${chatId}`,
            LIMIT: 40
        });

        return normalizeMessages(
            pick(result, ["messages", "list"], []),
            pick(result, ["users", "user"], {}),
            pick(result, ["files", "file"], {})
        );
    } catch (error) {
        return [];
    }
}

module.exports = async function handler(req, res) {
    if (req.method !== "GET") {
        res.statusCode = 405;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
    }

    const taskId = String(req.query?.id || "").trim();
    if (!taskId) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "Task id is required" }));
        return;
    }

    try {
        const task = await getTask(taskId);
        if (!task) {
            throw new Error("Task not found");
        }

        const chatId = pick(task, ["chatId", "CHAT_ID", "chat.id"], "");
        const [checklist, chatMessages] = await Promise.all([
            getChecklist(taskId),
            getChatMessages(chatId)
        ]);

        const creatorId = pick(task, ["createdBy", "CREATED_BY", "created_by"], "");
        const responsibleId = pick(task, ["responsibleId", "RESPONSIBLE_ID", "responsible_id"], "");

        const payload = {
            task: {
                id: pick(task, ["id", "ID"], taskId),
                title: pick(task, ["title", "TITLE"]),
                description: pick(task, ["description", "DESCRIPTION"]),
                statusCode: String(pick(task, ["status", "STATUS"], "")),
                statusLabel: STATUS_MAP[String(pick(task, ["status", "STATUS"], ""))] || "Без статуса",
                project: pick(task, ["groupName", "GROUP_NAME", "group_name"], "Без проекта"),
                creator: normalizeUserName(creatorId, task.creator || task.CREATOR),
                responsible: normalizeUserName(responsibleId, task.responsible || task.RESPONSIBLE),
                creatorId,
                responsibleId,
                accomplices: normalizeParticipants(pick(task, ["accomplices", "ACCOMPLICES"], [])),
                auditors: normalizeParticipants(pick(task, ["auditors", "AUDITORS"], [])),
                deadline: pick(task, ["deadline", "DEADLINE"]),
                createdDate: pick(task, ["createdDate", "CREATED_DATE"]),
                changedDate: pick(task, ["changedDate", "CHANGED_DATE"]),
                closedDate: pick(task, ["closedDate", "CLOSED_DATE"]),
                tags: normalizeTags(pick(task, ["tags", "TAGS"], [])),
                crm: pick(task, ["ufCrmTask", "UF_CRM_TASK"], []),
                chatId
            },
            checklist,
            chat: {
                dialogId: chatId ? `chat${chatId}` : "",
                messages: chatMessages
            }
        };

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify(payload));
    } catch (error) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: error.message || "Unexpected error" }));
    }
};
