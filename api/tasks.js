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

module.exports = async function handler(req, res) {
    if (req.method !== "GET") {
        res.statusCode = 405;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
    }

    try {
        // Запрашиваем список задач из Битрикса
        const result = await b24Call("tasks.task.list", {
            select: [
                "ID", "TITLE", "DESCRIPTION", "STATUS", "GROUP_ID", 
                "CREATED_BY", "RESPONSIBLE_ID", "DEADLINE", "CHANGED_DATE", "TAGS"
            ],
            filter: {
                // Здесь можно отфильтровать, например, только незакрытые задачи, если нужно
            },
            limit: 50
        });

        const tasks = result.tasks || [];

        // Форматируем под твой фронтенд
        const formattedTasks = tasks.map(task => ({
            id: task.id,
            title: task.title,
            description: task.description || "",
            lastActivityRaw: task.changedDate || "",
            deadline: task.deadline || "",
            author: task.creator?.name ? `${task.creator.name} ${task.creator.lastName || ''}`.trim() : `ID: ${task.createdBy}`,
            assignee: task.responsible?.name ? `${task.responsible.name} ${task.responsible.lastName || ''}`.trim() : `ID: ${task.responsibleId}`,
            project: task.group?.name || "Без проекта",
            rawStatus: task.status,
            tags: task.tags || []
        }));

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify(formattedTasks));
    } catch (error) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: error.message || "Ошибка получения списка задач" }));
    }
};
