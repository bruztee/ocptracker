const WebSocket = require('ws');
const axios = require('axios');

const SOLANA_WS_URL = "ws://162.249.175.2:8900"; // URL вашего Solana RPC WebSocket

// Флаг для отслеживания состояния подключения и переменные для управления переподключениями
let isConnected = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 20;
const BASE_RECONNECT_INTERVAL = 3000; // Начальный интервал (3 секунды)
let reconnectTimeout;
let pingInterval;

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
        
        // Задержка перед отправкой подписки, чтобы дать соединению стабилизироваться
        setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
                try {
                    // Подписка на все транзакции с разными уровнями подтверждения
                    ws.send(JSON.stringify({
                        jsonrpc: "2.0",
                        id: 1,
                        method: "logsSubscribe",
                        params: [
                            { "mentions": [] }, // Подписка на все транзакции
                            { "commitment": "processed" } // Начнем с "processed"
                        ]
                    }));
                    console.log(`📥 Подписка на логи отправлена`);
                } catch (err) {
                    console.error(`❌ Ошибка при отправке подписки: ${err.message}`);
                }
            }
        }, 1000); // Задержка 1 секунда перед подпиской
        
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
        }, 90000); // Отправка ping каждые 90 секунд
    });

    ws.on('message', async (data) => {
        try {
            const response = JSON.parse(data);
            
            // Проверка на ответ методу подписки
            if (response.id && !response.params) {
                console.log(`📥 Получен ответ ID:${response.id}: ${JSON.stringify(response).substring(0, 100)}...`);
                return;
            }

            if (response.params && response.params.result && response.params.result.value) {
                const signature = response.params.result.value.signature;
                const transaction = response.params.result.value.transaction;
                const commitment = response.params.result.value.commitment;

                // Логика для отслеживания уровня подтверждения
                console.log(`🔍 Новая транзакция: ${signature}`);
                console.log(`Commitment Level: ${commitment}`);

                // Добавляем проверку для всех уровней подтверждения
                if (commitment === 'processed') {
                    console.log(`✅ Транзакция на уровне "processed".`);
                } else if (commitment === 'confirmed') {
                    console.log(`✅ Транзакция на уровне "confirmed".`);
                } else if (commitment === 'finalized') {
                    console.log(`✅ Транзакция на уровне "finalized".`);
                }

                // Ограничиваем вывод данных транзакции для снижения объема логов
                if (transaction) {
                    console.log("Transaction Data available");
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
