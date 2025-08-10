const qrcode = require('qrcode-terminal');
const { google } = require('googleapis');
const { Client } = require('whatsapp-web.js');
const credentials = require('./credentials.json');

const client = new Client();
const sessions = new Map();
const delay = ms => new Promise(res => setTimeout(res, ms));

const cidades = {
  '1': 'Lagoa do Ouro',
  '2': 'Caruaru',
  '3': 'Garanhuns',
  '4': 'Correntes'
};

const horariosPadrao = {
  '1': '08:00',
  '2': '09:00',
  '3': '10:00',
  '4': '14:00',
  '5': '15:00'
};

const spreadsheetId = '1lJ2Hd3pk10HvvaWin3R_Tn1ztEHfNtYvp_7D5w7mji0';
const sheets = google.sheets('v4');
const calendar = google.calendar('v3');
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/calendar'
  ]
});

client.on('qr', qr => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log('✅ WhatsApp conectado.'));
client.initialize();

client.on('message', async msg => {
  if (!msg.from.endsWith('@c.us')) return;
  const id = msg.from;
  const text = msg.body.trim();
  const session = getSession(id);

  switch (session.stage) {
    case 'MENU':
      if (/^(menu|oi|ol[áa]|bom dia|boa tarde|boa noite)$/i.test(text)) {
        const contact = await msg.getContact();
        session.telefone = msg.from;

        if (contact.pushname) {
          session.nome = contact.pushname.split(' ')[0];
          await client.sendMessage(id, `Olá, ${session.nome}! 👋\nComo podemos ajudar?\n1⃣ Ver preços\n2⃣ Agendar exame`);
        } else {
          session.stage = 'NOME';
          await client.sendMessage(id, 'Olá! 😊 Qual é o seu *primeiro nome*?');
        }
      } else if (text === '1') {
        await client.sendMessage(id, getResumo());
      } else if (text === '2') {
        session.stage = 'EXAME';
        await client.sendMessage(id, 'Digite o exame que deseja realizar:');
      } else {
        await client.sendMessage(id, 'Digite *menu* para começar.');
      }
      break;

    case 'NOME':
      session.nome = text.split(' ')[0];
      await client.sendMessage(id, `Obrigado, ${session.nome}! 👋\nComo podemos ajudar?\n1⃣ Ver preços\n2⃣ Agendar exame`);
      session.stage = 'MENU';
      break;

    case 'EXAME':
      session.exames = text;
      session.stage = 'CIDADE';
      await client.sendMessage(id, 'Em qual cidade deseja fazer o exame?\n1⃣ Lagoa do Ouro\n2⃣ Caruaru\n3⃣ Garanhuns\n4⃣ Correntes');
      break;

    case 'CIDADE':
      if (!cidades[text]) return client.sendMessage(id, 'Opção inválida. Tente novamente.');
      session.cidade = cidades[text];
      if (text === '2') {
        session.stage = 'CLINICA';
        return client.sendMessage(id, `📍 *Clínicas em Caruaru:*\n1⃣ Clínica Aulas\n2⃣ Clínica Maurício Polito\n3⃣ Clínica Obgyn\n\nDigite o número da clínica desejada:`);
      } else {
        session.stage = 'DATA';
        return client.sendMessage(id, 'Digite a data desejada (ex: 20/08):');
      }

    case 'CLINICA':
      const clinicas = {
        '1': 'Clínica Aulas',
        '2': 'Clínica Maurício Polito',
        '3': 'Clínica Obgyn'
      };
      if (!clinicas[text]) return client.sendMessage(id, 'Opção inválida. Tente novamente.');
      session.clinica = clinicas[text];
      session.stage = 'DATA';
      return client.sendMessage(id, 'Digite a data desejada (ex: 15/08):');

    case 'DATA':
      session.data = text;
      session.dataFormatada = formatarDataParaISO(text);
      session.stage = 'HORARIO';
      if (session.cidade === 'Caruaru') {
        await client.sendMessage(id, getHorariosCaruaru(session.clinica));
      } else {
        await client.sendMessage(id, 'Escolha o horário:\n1⃣ 08:00\n2⃣ 09:00\n3⃣ 10:00\n4⃣ 14:00\n5⃣ 15:00');
      }
      break;

    case 'HORARIO':
      session.horario = horariosPadrao[text] || text;
      session.stage = 'CONFIRMA';
      await client.sendMessage(id,
        `⚠️ Confirme os dados:\n📌 Exame: ${session.exames}\n📌 Cidade: ${session.cidade}\n${session.clinica ? `📌 Clínica: ${session.clinica}\n` : ''}📌 Data: ${session.data}\n📌 Horário: ${session.horario}\n\n1⃣ Confirmar\n2⃣ Cancelar`);
      break;

    case 'CONFIRMA':
      if (text === '1') {
        try {
          await salvarNoGoogleSheets(session);
          await criarEventoGoogleAgenda(session);
          await client.sendMessage(id, '✅ Agendamento confirmado com sucesso!');
        } catch (err) {
          console.error(err);
          await client.sendMessage(id, '❌ Erro ao salvar. Tente novamente mais tarde.');
        }
      } else {
        await client.sendMessage(id, 'Agendamento cancelado. Digite *menu* para voltar.');
      }
      session.stage = 'MENU';
      break;
  }
});

function getSession(id) {
  if (!sessions.has(id)) sessions.set(id, { stage: 'MENU' });
  return sessions.get(id);
}

function getResumo() {
  return `👩‍⚕️ *Dra. Mariella Ribeiro – Ultrassonografia*\n\n💲 *Preços*:\n- USG abdominal: R$120\n- USG transvaginal com Doppler: R$200\n- USG transvaginal sem Doppler: R$140\n- USG obstétrica inicial: R$120\n- USG obstétrica fora de janela: R$150`;
}

function getHorariosCaruaru(clinica) {
  const horarios = {
    'Clínica Aulas': `*Horários Clínica Aulas (07–23/08)*:\n- 10:00 - 10:45\n- 11:00 - 11:45\n- 14:00 - 14:45\n- 15:00 - 15:45`,
    'Clínica Maurício Polito': `*Horários Clínica Maurício Polito (08–24/08)*:\n- 08:00 - 08:45\n- 09:00 - 09:45\n- 10:00 - 10:45\n- 11:00 - 11:45\n- 14:00 - 14:45\n- 15:00 - 15:45\n- 17:00 - 17:45`,
    'Clínica Obgyn': `*Horários Clínica Obgyn (07–23/08)*:\n- 14:00 - 14:45\n- 15:00 - 15:45\n- 16:00 - 16:45\n- 17:00 - 17:45\n- 18:00 - 18:45`
  };
  return horarios[clinica] || 'Horários indisponíveis.';
}

function formatarDataParaISO(dataStr) {
  const [dia, mes] = dataStr.split('/').map(Number);
  const ano = new Date().getFullYear();
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

async function salvarNoGoogleSheets(s) {
  const authClient = await auth.getClient();
  await sheets.spreadsheets.values.append({
    auth: authClient,
    spreadsheetId,
    range: 'A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[s.nome, s.telefone, s.exames, s.cidade, s.clinica || '', s.data, s.horario]]
    }
  });
}

async function criarEventoGoogleAgenda(s) {
  const authClient = await auth.getClient();
  const dataHoraInicio = new Date(`${s.dataFormatada}T${s.horario}:00-03:00`);
  const dataHoraFim = new Date(dataHoraInicio.getTime() + 30 * 60000);

  const evento = {
    summary: `Consulta de ${s.nome}`,
    location: s.cidade,
    description: `Exame(s): ${s.exames}\nTelefone: ${s.telefone}`,
    start: {
      dateTime: dataHoraInicio.toISOString(),
      timeZone: 'America/Recife',
    },
    end: {
      dateTime: dataHoraFim.toISOString(),
      timeZone: 'America/Recife',
    },
  };

  await calendar.events.insert({
    auth: authClient,
    calendarId: 'primary',
    resource: evento,
  });
}
