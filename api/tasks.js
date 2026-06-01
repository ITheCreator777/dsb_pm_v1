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
            "Content-Type": "application/json"
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

// Вспомогательная функция для безопасного разбора тегов в массив строк
function normalizeTags(rawTags) {
    if (!rawTags) return [];
    if (Array.isArray(rawTags)) return rawTags.map(String);
    if (typeof rawTags === "object") return Object.values(rawTags).map(String);
    if (typeof rawTags === "string") return rawTags.split(",").map(t => t.trim()).filter(Boolean);
    return [];
}

module.exports = async function handler(req, res) {
    if (req.method !== "GET") {
        res.statusCode = 405;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
    }

    try {
        // Запрашиваем полный набор полей, нужный для твоего дашборда
        const result = await b24Call("tasks.task.list", {
            select: [
                "ID", "TITLE", "DESCRIPTION", "STATUS", "GROUP_ID", "GROUP_NAME",
                "CREATED_BY", "RESPONSIBLE_ID", "DEADLINE", "CHANGED_DATE", "TAGS",
                "CREATOR", "RESPONSIBLE"
            ],
            filter: {
                // Показываем только незавершенные задачи, чтобы дашборд оставался сфокусированным
                 "STATUS": ["1","2","3","4"]
            },
            params: {
                "NAV_PARAMS": { "nPageSize": 100 } // Тянем до 100 активных задач
            }
        });

        const tasks = result.tasks || (Array.isArray(result) ? result : []);

        const formattedTasks = tasks.map(task => {
            // Собираем имя постановщика (Creator)
            let authorName = `ID: ${task.createdBy || task.CREATED_BY}`;
            const creator = task.creator || task.CREATOR;
            if (creator && creator.name) {
                authorName = `${creator.name} ${creator.lastName || ""}`.trim();
            }

            // Собираем имя ответственного (Responsible)
            let assigneeName = `ID: ${task.responsibleId || task.RESPONSIBLE_ID}`;
            const responsible = task.responsible || task.RESPONSIBLE;
            if (responsible && responsible.name) {
                assigneeName = `${responsible.name} ${responsible.lastName || ""}`.trim();
            }

            return {
                id: task.id || task.ID,
                title: task.title || task.TITLE || "Без названия",
                description: task.description || task.DESCRIPTION || "",
                lastActivityRaw: task.changedDate || task.CHANGED_DATE || "",
                deadline: task.deadline || task.DEADLINE || "",
                author: authorName,
                assignee: assigneeName,
                groupId: task.groupId || task.GROUP_ID || 0,
                // Название проекта/группы из Битрикса
                project: task.groupName || task.GROUP_NAME || "Без проекта",
                rawStatus: String(task.status || task.STATUS || "1"),
                // Жесткая и безопасная нормализация тегов
                tags: normalizeTags(task.tags || task.TAGS)
            };
        });

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify(formattedTasks));
    } catch (error) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: error.message || "Ошибка получения списка задач" }));
    }
};
