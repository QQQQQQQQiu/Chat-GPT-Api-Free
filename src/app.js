import express from "express";
import bodyParser from "body-parser";
import { encode } from "gpt-3-encoder";
import { randomUUID, randomInt, createHash } from "crypto";
import { config } from "dotenv";
config();
const port = process.env.SERVER_PORT
const baseUrl = "https://chat.openai.com";
const apiUrl = `${baseUrl}/backend-anon/conversation`;
const refreshInterval = 120000;
const errorWait = 120000;
const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.26 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.26"

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
            // line includes the EOL
            const line = previous.slice(0, eolIndex + 1).trimEnd();
            if (line === "data: [DONE]") break;
            if (line.startsWith("data: ")) yield line;
            previous = previous.slice(eolIndex + 1);
        }
    }
}
// Generate a proof token for the OpenAI API
function GenerateProofToken(seed, diff, userAgent) {
    const cores = [8, 12, 16, 24];
    const screens = [3000, 4000, 6000];

    const core = cores[randomInt(0, cores.length)];
    const screen = screens[randomInt(0, screens.length)];

    const now = new Date(Date.now() - 8 * 3600 * 1000);
    const parseTime = now.toUTCString().replace("GMT", "GMT-0500 (Eastern Time)");

    const config = [core + screen, parseTime, 4294705152, 0, userAgent];

    const diffLen = diff.length / 2;

    for (let i = 0; i < 100000; i++) {
        config[3] = i;
        const jsonData = JSON.stringify(config);
        const base = Buffer.from(jsonData).toString("base64");
        const hashValue = createHash("sha3-512")
            .update(seed + base)
            .digest();

        if (hashValue.toString("hex").substring(0, diffLen) <= diff) {
            const result = "gAAAAAB" + base;
            return result;
        }
    }

    const fallbackBase = Buffer.from(`"${seed}"`).toString("base64");
    return "gAAAAABwQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D" + fallbackBase;
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
async function getNewSession(tryCountNow = 1) {
    const tryCountMax = 5
    let newDeviceId = randomUUID();
    let response = null
    try {
        response = await fetch("https://chat.openai.com/backend-anon/sentinel/chat-requirements", {
            "headers": {
                "accept": "*/*",
                "accept-language": "zh,zh-CN;q=0.9,en;q=0.8,zh-TW;q=0.7",
                "cache-control": "no-cache",
                "content-type": "application/json",
                "oai-device-id": newDeviceId,
                "oai-language": "en-US",
                "pragma": "no-cache",
                "sec-ch-ua": '"Google Chrome";v="120", "Not:A-Brand";v="8", "Chromium";v="120"',
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": '"Windows"',
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "same-origin",
                // "user-agent": userAgent,
            },
            "referrer": baseUrl,
            "body": "{}",
            "method": "POST",
        });
        response = await response.json();
    } catch (error) {
        console.log('[Fail] :>> getNewSession Fail , trying', tryCountNow);
        await wait(500);
        if (tryCountMax >= tryCountNow) {
            return await getNewSession(tryCountNow + 1)
        }
        throw new Error(`ERROR: GET SESSION FAIL :::`, error)
    }
    if (!!response?.token) {
        console.log('request session done');
    } else {
        throw new Error(`!!!request session failed!!! => ${response}`)
    }
    response.deviceId = newDeviceId;
    return response
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

async function handleChatCompletion(req, res) {
    console.log("Request:", `${req.method} ${req.originalUrl}`, `${req.body?.messages?.length ?? 0} messages`, req.body.stream ? "(stream-enabled)" : "(stream-disabled)");
    try {
        let session = await getNewSession().catch(err => {
            res.write(err);
            return res.end();
        })
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
        let error = null
        let finish_reason = null;
        let proofToken = GenerateProofToken(
            session.proofofwork.seed,
            session.proofofwork.difficulty,
            userAgent
        );

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
        const response = await fetch(apiUrl, {
            method: "POST",
            "headers": {
                accept: "*/*",
                "accept-language": "en-US,en;q=0.9",
                "cache-control": "no-cache",
                "content-type": "application/json",
                "oai-language": "en-US",
                origin: baseUrl,
                pragma: "no-cache",
                "sec-ch-ua": '"Google Chrome";v="120", "Not:A-Brand";v="8", "Chromium";v="120"',
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": '"Windows"',
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "same-origin",
                "oai-device-id": session.deviceId,
                "openai-sentinel-chat-requirements-token": session.token,
                "openai-sentinel-proof-token": proofToken,
            },
            "user-agent": userAgent,
            "referrer": baseUrl,
            body: JSON.stringify(body),
        });
        for await (const message of StreamCompletion(response.body)) {
            if (message.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}.\d{6}$/)) {
                continue;
            }
            const parsed = JSON.parse(message);
            if (parsed.error) {
                error = `Error message from OpenAI: ${parsed.error}`;
                finish_reason = "stop";
                break;
            }
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
                            content: error ?? "",
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
                            content: error ?? fullContent,
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
        res.write(JSON.stringify({
            status: false,
            error: error
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
                await getNewSession();
                await wait(refreshInterval);
            }
            catch (error) {
                console.log('[Error getNewSession] :>> ', error);
                console.error("Error refreshing session ID, retrying in 2 minute...");
                console.error("If this error persists, your country may not be supported yet.");
                console.error("If your country was the issue, please consider using a U.S. VPN.");
                await wait(errorWait);
            }
        }
    }, 0);
});