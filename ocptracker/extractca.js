const axios = require('axios');

const SOLANA_RPC_URL = 'https://sparkling-special-theorem.solana-mainnet.quiknode.pro/6d4a18c7e4be2da15a6da53f87ce947ab1572f5f'; // Ваш RPC URL

// Функция для получения контрактов токенов по подписи транзакции с повторными попытками
async function getTokenContractsFromTransaction(signature, retries = 100) {
  let attempt = 0;
  let transactionDetails = null;

  while (attempt < retries && !transactionDetails) {
    attempt++;
    try {
      transactionDetails = await getTransactionDetails(signature);
      if (!transactionDetails) {
        console.log(`❌ Не удалось получить данные по транзакции, попытка ${attempt}`);
      } else {
        const contracts = extractTokenContracts(transactionDetails);
        if (contracts.length > 0) {
          return contracts;
        } else {
          console.log("❌ Токены в транзакции не найдены.");
          return [];
        }
      }
    } catch (error) {
      console.error(`❌ Ошибка при получении данных: ${error.message}`);
    }

    // Если не удалось получить данные, ждем перед следующей попыткой
    //await new Promise(resolve => setTimeout(resolve, 5000)); // 5 секунд задержки для retry
  }

  return [];
}

// Функция для получения деталей транзакции по подписи
async function getTransactionDetails(signature) {
  try {
    const response = await axios.post(SOLANA_RPC_URL, {
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [signature, { encoding: "jsonParsed", commitment: "finalized" , maxSupportedTransactionVersion: 0 }]
    });
    
    if (response.data.result) {
      return response.data.result;
    } else {
      console.error("❌ Транзакция не найдена в ответе.");
      return null;
    }
  } catch (error) {
    console.error("❌ Ошибка получения данных транзакции:${signature} ${response.data.result}", error.response?.data || error.message);
    return null;
  }
}

// Функция для извлечения контрактов токенов из транзакции
function extractTokenContracts(transactionDetails) {
  const contracts = [];

  // Проверяем наличие preTokenBalances и извлекаем контракты токенов
  if (transactionDetails.meta && transactionDetails.meta.preTokenBalances) {
    transactionDetails.meta.preTokenBalances.forEach(balance => {
      console.log(`Контракт токена: ${balance.mint}`);
      if (balance.mint && !contracts.includes(balance.mint)) {
        contracts.push(balance.mint);
      }
    });
  } else {
    console.log('❌ Токены в транзакции не найдены.');
  }

  return contracts;
}

// Экспортируем функцию
module.exports = getTokenContractsFromTransaction;
