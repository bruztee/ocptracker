const { google } = require('googleapis');
const { JWT } = require('google-auth-library');
const fs = require('fs');
const path = require('path');

// Конфигурация Google Sheets
const CREDENTIALS_PATH = path.join(__dirname, 'google-credentials.json');
const SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID'; // ID вашей Google таблицы
const SHEET_NAME = 'TokenContracts'; // Название листа в таблице

// Инициализация клиента для доступа к Google Sheets API
let sheetsClient = null;

/**
 * Инициализирует клиент Google Sheets API
 */
async function initGoogleSheets() {
  try {
    // Проверяем наличие файла с учетными данными
    if (!fs.existsSync(CREDENTIALS_PATH)) {
      console.error('❌ Файл с учетными данными Google API не найден!');
      console.error('Создайте сервисный аккаунт в Google Cloud Console и сохраните ключ в файл google-credentials.json');
      return false;
    }

    // Загружаем учетные данные
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    
    // Если файл с учетными данными содержит заглушки
    if (credentials.project_id === 'YOUR_PROJECT_ID') {
      console.error('❌ Файл с учетными данными Google API содержит заглушки!');
      console.error('Замените заглушки в файле google-credentials.json на реальные значения');
      return false;
    }

    // Создаем JWT-клиент с нужными правами
    const client = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    // Создаем клиент Google Sheets API
    sheetsClient = google.sheets({ version: 'v4', auth: client });
    console.log('✅ Google Sheets API инициализирован успешно');
    
    // Проверяем доступ к таблице
    await checkSpreadsheet();
    
    return true;
  } catch (error) {
    console.error('❌ Ошибка при инициализации Google Sheets API:', error.message);
    return false;
  }
}

/**
 * Проверяет доступ к таблице и создает лист, если его нет
 */
async function checkSpreadsheet() {
  try {
    // Получаем информацию о таблице
    const response = await sheetsClient.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
    });
    
    console.log(`✅ Доступ к таблице "${response.data.properties.title}" получен`);
    
    // Проверяем, существует ли нужный лист
    const sheets = response.data.sheets;
    const sheetExists = sheets.some(sheet => sheet.properties.title === SHEET_NAME);
    
    if (!sheetExists) {
      console.log(`⚠️ Лист "${SHEET_NAME}" не найден, создаем...`);
      
      // Создаем новый лист
      await sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: SHEET_NAME,
                },
              },
            },
          ],
        },
      });
      
      // Добавляем заголовки в новый лист
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A1:E1`,
        valueInputOption: 'RAW',
        resource: {
          values: [['Token Address', 'Discovery Time', 'Transaction ID', 'Pump.fun Link', 'BullX Link']],
        },
      });
      
      console.log(`✅ Лист "${SHEET_NAME}" создан и подготовлен`);
    }
    
    return true;
  } catch (error) {
    console.error('❌ Ошибка при проверке Google таблицы:', error.message);
    
    // Если таблица не найдена
    if (error.code === 404) {
      console.error(`❌ Таблица с ID=${SPREADSHEET_ID} не найдена. Проверьте ID таблицы и права доступа.`);
    }
    
    return false;
  }
}

/**
 * Добавляет новый токен-контракт в Google таблицу
 * @param {string} contract - Адрес контракта токена
 * @param {string} transactionId - ID транзакции, в которой был обнаружен контракт
 * @returns {Promise<boolean>} - Результат операции
 */
async function addContractToSheet(contract, transactionId) {
  if (!sheetsClient) {
    const initialized = await initGoogleSheets();
    if (!initialized) {
      return false;
    }
  }
  
  try {
    // Формируем строку данных для добавления
    const currentTime = new Date().toISOString();
    const pumpfunLink = `https://pump.fun/${contract}`;
    const bullxLink = `https://neo.bullx.io/terminal?chainId=1399811149&address=${contract}`;
    
    const rowData = [
      contract,                       // Адрес контракта
      currentTime,                    // Время обнаружения
      transactionId,                  // ID транзакции
      pumpfunLink,                    // Ссылка на pump.fun
      bullxLink                       // Ссылка на BullX
    ];
    
    // Получаем количество уже заполненных строк
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:A`,
    });
    
    const rowCount = response.data.values ? response.data.values.length : 0;
    const nextRow = rowCount + 1;
    
    // Добавляем новую строку
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A${nextRow}:E${nextRow}`,
      valueInputOption: 'RAW',
      resource: {
        values: [rowData],
      },
    });
    
    console.log(`✅ Контракт ${contract} добавлен в Google таблицу`);
    return true;
  } catch (error) {
    console.error('❌ Ошибка при добавлении в Google таблицу:', error.message);
    return false;
  }
}

module.exports = {
  initGoogleSheets,
  addContractToSheet
}; 