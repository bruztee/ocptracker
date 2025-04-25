const WebSocket = require('ws');
const axios = require('axios');
const getTokenContractsFromTransaction = require('./extractca'); // Подключаем модуль
const googleSheets = require('./google-sheets'); // Подключаем модуль Google Sheets

const SOLANA_WS_URL = "wss://little-blue-voice.solana-mainnet.quiknode.pro/e244147d0643e26f6457a8af3d12e9fe9b24c65f/";
const SOLANA_RPC_URL = "http://newyork.omeganetworks.io/"; // Используйте нужный RPC URL

// Вебхуки для отправки сообщений
const TRANSACTION_WEBHOOK_URL = "https://discord.com/api/webhooks/1339219442814419007/3YaVvyLuoL7vD8QNxlQl-hoRrFF9SH2oUXLW4Jh-Z_f6s4Nu5zfEA6VwChZYl_goPQu7";
const CONTRACT_WEBHOOK_URL = "https://discord.com/api/webhooks/1339178923199827968/9me92uU41YyU0gfj6oh-5tM8_QU3OmczIRQqMC367edWjYhODQlhobbdw7LeyaJi6cYS";

const monitoredOCPs = new Set([
    "infwiWUCBtdDG61p285W5uaxC3VpvwP3Ww1KEbkLSx9",
    "HcBxoEUVA1FQNmbrnvgA48WS8PRH1stErmUS8uxhARKp"
]);

const transactionQueue = [];
const contractQueue = [];
const MAX_MESSAGES_PER_SECOND = 50;
const MESSAGE_DELAY_MS = 1000; // Задержка между сообщениями в миллисекундах
let lastTransactionTime = Date.now();
let lastContractTime = Date.now();

// Множество для отслеживания отправленных контрактов
const sentContracts = new Set();

// Флаг для отслеживания состояния подключения и переменные для управления переподключениями
let isConnected = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 20;
const BASE_RECONNECT_INTERVAL = 3000; // Начальный интервал (3 секунды)
let reconnectTimeout;
let pingInterval;

// Модифицируем для более надежной обработки очередей и работы с Discord
const MAX_MESSAGES_PER_SECOND_DISCORD = 1; // Максимум 1 сообщение в секунду для Discord
const MESSAGE_DELAY_MS_DISCORD = 2000; // Задержка между сообщениями - 2 секунды
let lastContractTime_discord = Date.now();
let isProcessingQueue = false; // Флаг для предотвращения одновременного запуска нескольких обработчиков
let discordBackoffDelay = 1000; // Начальная задержка для Discord при ошибках
const MAX_DISCORD_BACKOFF = 60000; // Максимальная задержка при ошибках Discord (1 минута)
let discordErrorCount = 0; // Счетчик ошибок Discord

// Инициализируем Google Sheets при старте
googleSheets.initGoogleSheets().then(success => {
    if (success) {
        console.log('✅ Готов к записи контрактов в Google Sheets');
    } else {
        console.log('⚠️ Запись в Google Sheets не доступна. Будет работать только отправка в Discord.');
    }
});

// Функция для вычисления задержки с экспоненциальным ростом
function getBackoffDelay(attempt) {
    // Экспоненциальный рост с ограничением максимальной задержки в 2 минуты
    return Math.min(BASE_RECONNECT_INTERVAL * Math.pow(1.5, attempt), 120000);
}

// Функция для установки подключения к WebSocket
function connectWebSocket() {
    console.log(`📡 Попытка подключения к WebSocket...`);
    
    const ws = new WebSocket(SOLANA_WS_URL, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36'
        },
        handshakeTimeout: 30000, // Увеличиваем таймаут рукопожатия до 30 секунд
    });
    
    ws.on('open', () => {
        console.log("✅ Подключено к Solana WebSocket");
        isConnected = true;
        reconnectAttempts = 0;
        
        // Настраиваем подписки с задержкой между ними, чтобы избежать резкого всплеска запросов
        monitoredOCPs.forEach((ocp, index) => {
            setTimeout(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    try {
                        ws.send(JSON.stringify({
                            jsonrpc: "2.0",
                            id: index + 1,
                            method: "logsSubscribe",
                            params: [
                                { "mentions": [ocp] },
                                { "commitment": "finalized" }
                            ]
                        }));
                        console.log(`📥 Подписка на ${ocp} отправлена`);
                    } catch (err) {
                        console.error(`❌ Ошибка при отправке подписки: ${err.message}`);
                    }
                }
            }, index * 1000); // Задержка 1 секунда между подписками
        });
        
        // Настраиваем ping-pong для поддержания соединения - более редкий интервал
        if (pingInterval) clearInterval(pingInterval);
        pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                try {
                    ws.ping();
                    console.log("🔄 WebSocket ping отправлен");
                } catch (err) {
                    console.error(`❌ Ошибка отправки ping: ${err.message}`);
                }
            }
        }, 90000); // Отправка ping каждые 90 секунд вместо 30
    });

    ws.on('message', async (data) => {
        try {
            const response = JSON.parse(data);
            // Проверка на ответ методу отличному от logsSubscribe (например, подтверждение подписки)
            if (response.id && !response.params) {
                console.log(`📥 Получен ответ ID:${response.id}: ${JSON.stringify(response).substring(0, 100)}...`);
                return;
            }
            
            if (response.params && response.params.result && response.params.result.value) {
                const signature = response.params.result.value.signature;
                console.log("🔍 New txn:", signature);

                // Проверяем контракты токенов в транзакции с помощью модуля
                try {
                    const contracts = await getTokenContractsFromTransaction(signature);
                    if (contracts.length > 0) {
                        for (const contract of contracts) {
                            if (!sentContracts.has(contract)) {
                                // Если контракт еще не отправлялся, добавляем его в очередь для контрактов
                                sentContracts.add(contract);
                                
                                // Формируем сообщение для Discord
                                contractQueue.push({
                                    content: `📄 New Ca: **${contract}**\n https://pump.fun/${contract}\n https://neo.bullx.io/terminal?chainId=1399811149&address=${contract}\n`,
                                    timestamp: Date.now(),
                                    retries: 0
                                });
                                
                                // Запускаем обработку очереди только если она еще не запущена
                                if (!isProcessingQueue) {
                                    processContractQueue();
                                }
                                
                                // Добавляем контракт в Google Sheets
                                googleSheets.addContractToSheet(contract, signature)
                                    .then(success => {
                                        if (success) {
                                            console.log(`📊 Контракт ${contract} добавлен в Google Sheets`);
                                        } else {
                                            console.error(`❌ Не удалось добавить контракт ${contract} в Google Sheets`);
                                        }
                                    })
                                    .catch(error => {
                                        console.error(`❌ Ошибка при добавлении в Google Sheets: ${error.message}`);
                                    });
                            }
                        }
                    }
                } catch (err) {
                    console.error(`❌ Ошибка при обработке транзакции ${signature}: ${err.message}`);
                }
            }
        } catch (err) {
            console.error(`❌ Ошибка обработки сообщения WebSocket: ${err.message}`);
        }
    });
    
    ws.on('ping', () => {
        console.log("📥 Получен ping от сервера");
        try {
            ws.pong();
        } catch (err) {
            console.error(`❌ Ошибка отправки pong: ${err.message}`);
        }
    });
    
    ws.on('pong', () => {
        console.log("📤 Сервер ответил pong");
    });

    ws.on('error', (error) => {
        console.error(`❌ WebSocket ошибка: ${error.message}`);
        // Проверяем на типичные ошибки превышения лимита
        if (error.message.includes('429') || error.message.includes('too many requests') || 
            error.message.includes('rate limit') || error.message.includes('limit exceeded')) {
            console.log("⚠️ Обнаружено превышение лимита запросов!");
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`🔴 WebSocket отключен (код: ${code}, причина: ${reason || 'не указана'}). Переподключение...`);
        isConnected = false;
        
        // Очищаем ping интервал
        if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
        }
        
        // Пытаемся переподключиться с экспоненциальным отступом
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            const delay = getBackoffDelay(reconnectAttempts);
            reconnectAttempts++;
            console.log(`Попытка переподключения ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} через ${delay/1000} секунд`);
            
            if (reconnectTimeout) clearTimeout(reconnectTimeout);
            reconnectTimeout = setTimeout(() => {
                connectWebSocket();
            }, delay);
        } else {
            console.log("❌ Достигнуто максимальное количество попыток переподключения. Перезапуск процесса через 60 секунд...");
            setTimeout(() => process.exit(1), 60000); // Даём минуту перед перезапуском
        }
    });
    
    return ws;
}

// Запускаем подключение
const ws = connectWebSocket();

async function processTransactionQueue() {
    if (transactionQueue.length === 0) return;

    const now = Date.now();
    const timeDiff = now - lastTransactionTime;

    if (timeDiff >= MESSAGE_DELAY_MS) {
        const message = transactionQueue.shift();
        await delay(3000);
        const success = true //await sendToDiscord(TRANSACTION_WEBHOOK_URL, message);
        if (success) {
            lastTransactionTime = Date.now();
        } else {
            // В случае ошибки добавляем сообщение обратно в очередь
            transactionQueue.push(message);
        }
        setTimeout(processTransactionQueue, MESSAGE_DELAY_MS);
    } else {
        setTimeout(processTransactionQueue, MESSAGE_DELAY_MS - timeDiff);
    }
}

// Обновленная функция обработки очереди контрактов
async function processContractQueue() {
    if (contractQueue.length === 0) {
        isProcessingQueue = false;
        return;
    }

    isProcessingQueue = true;
    const now = Date.now();
    const timeDiff = now - lastContractTime_discord;
    
    // Либо ждем необходимую задержку между сообщениями, либо используем delay от бэкоффа
    const effectiveDelay = Math.max(MESSAGE_DELAY_MS_DISCORD - timeDiff, 0);
    
    if (effectiveDelay > 0) {
        await delay(effectiveDelay);
    }
    
    // Берем самый старый элемент из очереди
    const messageData = contractQueue.shift();
    
    try {
        console.log(`📤 Отправка в Discord (попытка ${messageData.retries + 1}): ${messageData.content.substring(0, 30)}...`);
        const success = await sendToDiscord(CONTRACT_WEBHOOK_URL, messageData.content);
        
        if (success) {
            console.log(`✅ Успешно отправлено в Discord (в очереди осталось: ${contractQueue.length})`);
            lastContractTime_discord = Date.now();
            discordErrorCount = 0; // Сбрасываем счетчик ошибок при успехе
            discordBackoffDelay = 1000; // Сбрасываем задержку
        } else {
            handleDiscordError(messageData);
        }
    } catch (error) {
        console.error(`❌ Ошибка при отправке в Discord: ${error.message}`);
        handleDiscordError(messageData);
    }
    
    // Продолжаем обработку очереди с небольшой задержкой
    setTimeout(processContractQueue, 500);
}

// Функция для обработки ошибок отправки в Discord
function handleDiscordError(messageData) {
    discordErrorCount++;
    
    // Увеличиваем задержку экспоненциально при повторных ошибках
    if (discordErrorCount > 1) {
        discordBackoffDelay = Math.min(discordBackoffDelay * 2, MAX_DISCORD_BACKOFF);
    }
    
    console.log(`⚠️ Ошибка Discord, увеличиваю задержку до ${discordBackoffDelay/1000}s (ошибок: ${discordErrorCount})`);
    
    // Увеличиваем счетчик попыток и возвращаем обратно в очередь, если попыток меньше 5
    if (messageData.retries < 5) {
        messageData.retries++;
        messageData.timestamp = Date.now(); // Обновляем время
        
        // Возвращаем обратно в очередь, но с задержкой в зависимости от количества ошибок
        setTimeout(() => {
            contractQueue.push(messageData);
        }, discordBackoffDelay);
    } else {
        console.error(`❌ Достигнут лимит попыток для сообщения: ${messageData.content.substring(0, 30)}...`);
    }
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendToDiscord(webhookUrl, message) {
    try {
        const response = await axios.post(webhookUrl, { content: message }, {
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 10000 // Таймаут 10 секунд
        });
        
        // Проверяем на признаки ошибок rate limiting
        if (response.status === 429) {
            const retryAfter = response.headers['retry-after'] || 5;
            console.log(`⚠️ Discord rate limit, ожидание ${retryAfter}s`);
            await delay(retryAfter * 1000);
            return false;
        }
        
        if (response.status >= 200 && response.status < 300) {
            return true; // Успех
        } else {
            console.error(`❌ Неудачный статус ответа Discord: ${response.status}`);
            return false;
        }
    } catch (error) {
        console.error("❌ Ошибка отправки в Discord:", error.response?.data || error.message);
        
        // Если это ошибка превышения лимита запросов, извлекаем retry-after
        if (error.response && error.response.status === 429) {
            const retryAfter = error.response.headers['retry-after'] || 5;
            console.log(`⚠️ Discord rate limit, ожидание ${retryAfter}s`);
            await delay(retryAfter * 1000);
        } else {
            // Для других ошибок ждем стандартную задержку
            await delay(3000);
        }
        
        return false; // Ошибка
    }
}

// Обработка завершения процесса для корректного закрытия соединений
process.on('SIGINT', () => {
    console.log('Получен сигнал завершения. Закрытие соединений...');
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            ws.close(1000, "Штатное завершение");
        } catch (err) {
            console.error(`Ошибка при закрытии WebSocket: ${err.message}`);
        }
    }
    process.exit(0);
});
