import express from "express";
import bodyParser from "body-parser";
import { encode } from "gpt-3-encoder";
import { config } from "dotenv";
config();
const port = process.env.SERVER_PORT
const baseUrl = "https://chat.openai.com";
const apiUrl = `${baseUrl}/backend-anon/conversation`;
const refreshInterval = 60000;
const errorWait = 120000;
let token;
let oaiDeviceId;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function randomUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0,
            v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}
function GenerateCompletionId(prefix = "cmpl-") {
    const characters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const length = 28;
    for (let i = 0; i < length; i++) {
        prefix += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return prefix;
}
async function* chunksToLines(chunksAsync) {
    let previous = "";
    for await (const chunk of chunksAsync) {
        const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        previous += bufferChunk;
        let eolIndex;
        while ((eolIndex = previous.indexOf("\n")) >= 0) {
            const line = previous.slice(0, eolIndex + 1).trimEnd();
            if (line === "data: [DONE]")
                break;
            if (line.startsWith("data: "))
                yield line;
            previous = previous.slice(eolIndex + 1);
        }
    }
}
async function* linesToMessages(linesAsync) {
    for await (const line of linesAsync) {
        const message = line.substring("data :".length);
        yield message;
    }
}
async function* StreamCompletion(data) {
    yield* linesToMessages(chunksToLines(data));
}
async function getNewSessionId() {
    let newDeviceId = randomUUID();
    let response = await fetch("https://chat.openai.com/backend-anon/sentinel/chat-requirements", {
        "headers": {
            "accept": "*/*",
            "accept-language": "zh,zh-CN;q=0.9,en;q=0.8,zh-TW;q=0.7",
            "cache-control": "no-cache",
            "content-type": "application/json",
            "oai-device-id": newDeviceId,
            "oai-language": "en-US",
            "pragma": "no-cache",
            "sec-ch-ua": "\" Not A;Brand\";v=\"99\", \"Chromium\";v=\"100\"",
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": "\"macOS\"",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin"
        },
        "referrer": "https://chat.openai.com/",
        "body": "{}",
        "method": "POST",
    });
    response = await response.json();
    console.log('[getNewSessionId response] :>> ', JSON.stringify(response));
    console.log(`System: Successfully refreshed session ID and token. ${!token ? "(Now it's ready to process requests)" : ""}`);
    oaiDeviceId = newDeviceId;
    token = response.token;
}
function enableCORS(req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }
    next();
}
function sendApiRequest(bodyObj) {
    return fetch(apiUrl, {
        method: "POST",
        headers: {
            accept: "*/*",
            "accept-language": "en-US,en;q=0.9",
            "cache-control": "no-cache",
            "content-type": "application/json",
            "oai-language": "en-US",
            origin: baseUrl,
            pragma: "no-cache",
            referer: baseUrl,
            "pragma": "no-cache",
            "sec-ch-ua": "\" Not A;Brand\";v=\"99\", \"Chromium\";v=\"100\"",
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": "\"macOS\"",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
            "oai-device-id": oaiDeviceId,
            "openai-sentinel-chat-requirements-token": token,
        },
        referer: baseUrl,
        body: JSON.stringify(bodyObj),
    });
}
async function handleChatCompletion(req, res) {
    console.log("Request:", `${req.method} ${req.originalUrl}`, `${req.body?.messages?.length ?? 0} messages`, req.body.stream ? "(stream-enabled)" : "(stream-disabled)");
    try {
        let promptTokens = 0;
        let completionTokens = 0;
        for (let message of req.body.messages) {
            promptTokens += encode(message.content).length;
        }
        if (req.body.stream) {
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
        }
        else {
            res.setHeader("Content-Type", "application/json");
        }
        let fullContent = "";
        let requestId = GenerateCompletionId("chatcmpl-");
        let created = Math.floor(Date.now() / 1000);
        let finish_reason = null;

        const body = {
            action: "next",
            messages: req.body.messages.map((message) => ({
                author: { role: message.role },
                content: { content_type: "text", parts: [message.content] },
            })),
            parent_message_id: randomUUID(),
            model: "text-davinci-002-render-sha",
            timezone_offset_min: -180,
            suggestions: [],
            history_and_training_disabled: true,
            conversation_mode: { kind: "primary_assistant" },
            websocket_request_id: randomUUID(),
        };
        const response = await sendApiRequest(body)
        for await (const message of StreamCompletion(response.body)) {
            if (message.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}.\d{6}$/)) {
                continue;
            }
            const parsed = JSON.parse(message);
            // console.log('00000000000000');
            // console.log('parsed :>> ', parsed);
            // console.log('1111111111111111111');
            // debugger
            let content = parsed?.message?.content?.parts[0] ?? "";
            let status = parsed?.message?.status ?? ""
            for (let message of req.body.messages) {
                if (message.content === content) {
                    content = "";
                    break;
                }
            }
            switch (status) {
                case "in_progress":
                    finish_reason = null;
                    break;
                case "finished_successfully":
                    let finish_reason_data = parsed?.message?.metadata?.finish_details?.type ?? null;
                    switch (finish_reason_data) {
                        case "max_tokens":
                            finish_reason = "length";
                            break;
                        case "stop":
                        default:
                            finish_reason = "stop";
                    }
                    break;
                default:
                    finish_reason = null;
            }
            if (content === "") continue;
            let completionChunk = content.replace(fullContent, "");
            completionTokens += encode(completionChunk).length;
            if (req.body.stream) {
                let response = {
                    id: requestId,
                    created: created,
                    object: "chat.completion.chunk",
                    model: "gpt-3.5-turbo",
                    choices: [
                        {
                            delta: {
                                content: completionChunk,
                            },
                            index: 0,
                            finish_reason: finish_reason,
                        },
                    ],
                };
                res.write(`${JSON.stringify(response)}\n\n`);
            }
            fullContent = content.length > fullContent.length ? content : fullContent;
        }
        if (req.body.stream) {
            let response = {
                id: requestId,
                created: created,
                object: "chat.completion.chunk",
                model: "gpt-3.5-turbo",
                choices: [
                    {
                        delta: {
                            content: "",
                        },
                        index: 0,
                        finish_reason: finish_reason,
                    },
                ],
            }
            res.write(`${JSON.stringify(response)}\n\n`);
        }
        else {
            let response = {
                id: requestId,
                created: created,
                model: "gpt-3.5-turbo",
                object: "chat.completion",
                choices: [
                    {
                        finish_reason: finish_reason,
                        index: 0,
                        message: {
                            content: fullContent,
                            role: "assistant",
                        },
                    },
                ],
                usage: {
                    prompt_tokens: promptTokens,
                    completion_tokens: completionTokens,
                    total_tokens: promptTokens + completionTokens,
                },
            }
            res.write(`${JSON.stringify(response)}\n\n`);
        }
        res.end();
    }
    catch (error) {
        console.log('!!!!!!!!error!!!!!! :>> ', error);
        if (!res.headersSent)
            res.setHeader("Content-Type", "application/json");
        res.write(JSON.stringify({
            status: false,
            error: {
                message: "An error occurred. Please check the server console to confirm it is ready and free of errors. Additionally, ensure that your request complies with OpenAI's policy.",
                type: "invalid_request_error",
            },
            support: "https://discord.pawan.krd",
        }));
        res.end();
    }
}


const app = express();
app.use(bodyParser.json());
app.use(enableCORS);
app.post("/v1/chat/completions", handleChatCompletion)
app.use((req, res) => res.status(404).send({
    status: false,
    error: {
        status: 404,
        message: `The requested endpoint (${req.method.toLocaleUpperCase()} ${req.path}) was not found. please make sure to use "http://localhost:${port}/v1" as the base URL.`,
        type: "invalid_request_error",
    },
}));
app.listen(port, async () => {
    console.log('start ...');
    console.log(`listen at port ${port}`);
    setTimeout(async () => {
        while (true) {
            try {
                await getNewSessionId();
                await wait(refreshInterval);
            }
            catch (error) {
                console.error("Error refreshing session ID, retrying in 2 minute...");
                console.error("If this error persists, your country may not be supported yet.");
                console.error("If your country was the issue, please consider using a U.S. VPN.");
                await wait(errorWait);
            }
        }
    }, 0);
});