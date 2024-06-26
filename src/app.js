import express from "express";
import bodyParser from "body-parser";
import { encode } from "gpt-3-encoder";
import { randomUUID, randomInt, createHash } from "crypto";
import { config } from "dotenv";
config();
const port = process.env.SERVER_PORT
const baseUrl = "https://chat.openai.com";
const apiUrl = `${baseUrl}/backend-anon/conversation`;
const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.60 Safari/537.36'

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
        const headers = {
            'authority': 'chat.openai.com',
            'accept': '*/*',
            'accept-language': 'zh,zh-CN;q=0.9,en;q=0.8,zh-TW;q=0.7',
            'cache-control': 'no-cache',
            'content-type': 'application/json',
            'cookie': ` oai-did=${newDeviceId}; cf_clearance=W3ImywbSVr5xLVzWm8x8FM1fpNv2vfbIsz7pUTxL0dI-1714034807-1.0.1.1-BxsE1GxPMo2n8SPAvKcbmE99.FXwhZufEgmPW19_D01ND8biSezWcwqKu8qQ.Etvtbd5ZEe2N2WUcYWePMbKtw; __Secure-next-auth.callback-url=https%3A%2F%2Fchat.openai.com`,
            'oai-device-id': newDeviceId,
            'oai-language': 'en-US',
            'origin': 'https://chat.openai.com',
            'pragma': 'no-cache',
            'referer': 'https://chat.openai.com/',
            'sec-ch-ua': '" Not A;Brand";v="99", "Chromium";v="100"',
            'sec-ch-ua-arch': '"x86"',
            'sec-ch-ua-bitness': '"64"',
            'sec-ch-ua-full-version': '"100.0.4896.60"',
            'sec-ch-ua-full-version-list': '" Not A;Brand";v="99.0.0.0", "Chromium";v="100.0.4896.60"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-model': '',
            'sec-ch-ua-platform': '"macOS"',
            'sec-ch-ua-platform-version': '"10.15.7"',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin',
            'user-agent': userAgent
        };
        response = await fetch("https://chat.openai.com/backend-anon/sentinel/chat-requirements", {
            headers,
            body: "{}",
            method: "POST",
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
    if (!response?.token) {
        throw new Error(`!!!request session FAIL!!! => ${JSON.stringify(response)}`)   
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
    let msgArr = req.body?.messages || []
    let logStr = ``
    msgArr.forEach(message => {
        if (message.role === 'user') {
            logStr += `${message.content}\n`
        }
    });
    console.log(new Date().toLocaleString(), ": Request:", `${req.method} ${req.originalUrl}`, `${req.body?.messages?.length ?? 0} messages`, req.body.stream ? "(stream-enabled)" : "(stream-disabled)", '\n```\n', logStr, '\n ```');
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
        const headers = {
            'authority': 'chat.openai.com',
            'accept': '*/*',
            'accept-language': 'zh,zh-CN;q=0.9,en;q=0.8,zh-TW;q=0.7',
            'cache-control': 'no-cache',
            'content-type': 'application/json',
            'cookie': ` oai-did=${session.deviceId}; cf_clearance=W3ImywbSVr5xLVzWm8x8FM1fpNv2vfbIsz7pUTxL0dI-1714034807-1.0.1.1-BxsE1GxPMo2n8SPAvKcbmE99.FXwhZufEgmPW19_D01ND8biSezWcwqKu8qQ.Etvtbd5ZEe2N2WUcYWePMbKtw; __Secure-next-auth.callback-url=https%3A%2F%2Fchat.openai.com`,
            'oai-device-id': session.deviceId,
            'oai-language': 'en-US',
            'origin': 'https://chat.openai.com',
            'pragma': 'no-cache',
            'referer': 'https://chat.openai.com/',
            'sec-ch-ua': '" Not A;Brand";v="99", "Chromium";v="100"',
            'sec-ch-ua-arch': '"x86"',
            'sec-ch-ua-bitness': '"64"',
            'sec-ch-ua-full-version': '"100.0.4896.60"',
            'sec-ch-ua-full-version-list': '" Not A;Brand";v="99.0.0.0", "Chromium";v="100.0.4896.60"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-model': '',
            'sec-ch-ua-platform': '"macOS"',
            'sec-ch-ua-platform-version': '"10.15.7"',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin',
            'user-agent': userAgent,
            "oai-device-id": session.deviceId,
            "openai-sentinel-chat-requirements-token": session.token,
            "openai-sentinel-proof-token": proofToken,
        }
        const response = await fetch(apiUrl, {
            method: "POST",
            headers,
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
        try {
            await getNewSession();
            console.log('test success :>> your network connected');
        }
        catch (error) {
            console.log('[Error getNewSession] :>> ', error);
        }
    }, 0);
});