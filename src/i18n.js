// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature and option names, the status of
// the integration, the answers of the button and the command errors.
// -----------------------------------------------------------------------------

import { KINDS, STATUS_ROLE, TIMINGS } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** Two texts, one after the other, in both languages. */
export const join = (a, b) => both(`${a.en} ${b.en}`, `${a.fr} ${b.fr}`);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

const decimal = (value, language) =>
  language === 'en' ? String(value) : String(value).replace('.', ',');

export const FEATURE_NAMES = {
  [STATUS_ROLE]: both('Status', 'État'),
  [KINDS.CIRCUIT]: both('On / off', 'Marche / arrêt'),
  [KINDS.WATER_TEMP]: both('Water temperature', "Température de l'eau"),
  [KINDS.SETPOINT]: both('Heating set point', 'Consigne de chauffage'),
  [KINDS.HEAT_MODE]: both('Heat mode', 'Mode de chauffage'),
  [KINDS.HEATING]: both('Heating now', 'Chauffe en cours'),
  [KINDS.PUMP_RUNNING]: both('Running', 'En marche'),
  [KINDS.PUMP_RPM]: both('Speed (rpm)', 'Vitesse (tr/min)'),
  [KINDS.PUMP_POWER]: both('Power', 'Puissance'),
  [KINDS.SENSOR_TEMP]: both('Temperature', 'Température'),
  [KINDS.PH]: both('pH', 'pH'),
  [KINDS.ORP]: both('ORP', 'Redox (ORP)'),
  [KINDS.PH_SETPOINT]: both('pH set point', 'Consigne de pH'),
  [KINDS.ORP_SETPOINT]: both('ORP set point', 'Consigne redox (ORP)'),
  [KINDS.SALT]: both('Salt (ppm)', 'Sel (ppm)'),
};

/** The names of objects without a name of their own, by kind. */
export const OBJECT_NAMES = {
  BODY: both('Body', 'Bassin'),
  CIRCUIT: both('Circuit', 'Circuit'),
  PUMP: both('Pump', 'Pompe'),
  SENSE: both('Sensor', 'Capteur'),
  CHEM: both('Chemistry', 'Chimie'),
};

export const CIRCUIT_LABELS = {
  off: both('Off', 'Arrêt'),
  on: both('On', 'Marche'),
};

export const HEAT_MODE_LABELS = {
  off: both('Off', 'Arrêt'),
  heater: both('Heater', 'Réchauffeur'),
  'solar-only': both('Solar only', 'Solaire seul'),
  'solar-preferred': both('Solar preferred', 'Solaire en priorité'),
  ultratemp: both('UltraTemp only', 'UltraTemp seule'),
  'ultratemp-preferred': both('UltraTemp preferred', 'UltraTemp en priorité'),
  'hybrid-gas': both('Hybrid: gas', 'Hybride : gaz'),
  'hybrid-heat-pump': both('Hybrid: heat pump', 'Hybride : pompe à chaleur'),
  hybrid: both('Hybrid: hybrid', 'Hybride : hybride'),
  'hybrid-dual': both('Hybrid: dual', 'Hybride : double'),
  mastertemp: both('MasterTemp', 'MasterTemp'),
  'max-e-therm': both('Max-E-Therm', 'Max-E-Therm'),
  'eti-250': both('ETi 250', 'ETi 250'),
};

export const STATE_TEXTS = {
  online: both('Connected', 'Connecté'),
  offline: both('Panel unreachable', 'Panneau injoignable'),
};

/** What a stop writes, for the status and the logs. */
const STOP_WHAT = {
  STATUS: both('off', 'arrêt'),
  MODE: both('heating off', 'chauffage arrêté'),
};

/** The status of the configuration screen. */
export const T = {
  noHost: both(
    'Enter the IP address of the IntelliCenter panel, then save.',
    "Saisissez l'adresse IP du panneau IntelliCenter, puis enregistrez.",
  ),
  invalidHost: (text) =>
    both(
      `"${text}" is not an IPv4 address nor a host name.`,
      `« ${text} » n'est ni une adresse IPv4 ni un nom d'hôte.`,
    ),
  configUnreadable: both(
    'The configuration cannot be read from Gladys: tried again every 30 s.',
    'La configuration ne peut pas être lue depuis Gladys : nouvel essai toutes les 30 s.',
  ),
  connecting: both('Connecting to the panel...', 'Connexion au panneau...'),
  unreachable: (address, wait) =>
    both(
      `The panel does not answer at ${address} (TCP): next try in ${wait.en}.`,
      `Le panneau ne répond pas à ${address} (TCP) : nouvel essai dans ${wait.fr}.`,
    ),
  failing: (reason, wait) =>
    both(
      `Reading the panel failed (${reason}): next try in ${wait.en}.`,
      `La lecture du panneau a échoué (${reason}) : nouvel essai dans ${wait.fr}.`,
    ),
  notPanel: both(
    'The device at this address does not answer like an IntelliCenter panel (no system name).',
    "L'appareil à cette adresse ne répond pas comme un panneau IntelliCenter (pas de nom de système).",
  ),
  summary: ({ name, circuits, unit }) =>
    both(
      `${name}: ${circuits} circuit(s) read${unit ? `, panel in °${unit}` : ', unit of the panel unknown'}.`,
      `${name} : ${circuits} circuit(s) lu(s)${unit ? `, panneau en °${unit}` : ', unité du panneau inconnue'}.`,
    ),
  connected: (summary) => both(`Connected. ${summary.en}`, `Connecté. ${summary.fr}`),
  commandsOff: (off) =>
    both(
      `Not allowed from Gladys: ${off.map((o) => o.en).join(', ')} (turning off always works).`,
      `Non autorisé depuis Gladys : ${off.map((o) => o.fr).join(', ')} (l'arrêt fonctionne toujours).`,
    ),
  optionCircuits: both('circuits and pumps', 'circuits et pompes'),
  optionLights: both('lights', 'éclairages'),
  optionHeating: both('heating', 'chauffage'),
  otherPanel: (names) =>
    both(
      `Another panel answers at this address: ${names} no longer read.`,
      `Un autre panneau répond à cette adresse : ${names} n'est plus lu.`,
    ),
  stopState: (name, attr, state, code) => {
    const what = STOP_WHAT[attr] ?? STOP_WHAT.STATUS;
    const states = {
      notSent: both('not sent yet, tried again', 'pas encore envoyé, réessayé'),
      waiting: both('sent, waiting for the read back', 'envoyé, en attente de relecture'),
      refused: both(
        `refused by the panel (${code}), written again later (15 s, then up to 5 min)`,
        `refusé par le panneau (${code}), réécrit plus tard (15 s, puis jusqu'à 5 min)`,
      ),
      coolDown: both(
        'mode Off shown, the body still heats (cool-down): watched',
        'mode Arrêt affiché, le bassin chauffe encore (refroidissement) : surveillé',
      ),
      heatUnknown: both(
        'mode Off shown, the heating state cannot be read: check on the panel',
        "mode Arrêt affiché, l'état de chauffe est illisible : vérifiez sur le panneau",
      ),
      stillHeating: both(
        'mode Off shown, but the body still heats: check on the panel',
        'mode Arrêt affiché, mais le bassin chauffe encore : vérifiez sur le panneau',
      ),
      held: both(
        `written ${TIMINGS.stopResends + 1} times without effect: held, no more writes until a new click or the panel shows it`,
        `écrit ${TIMINGS.stopResends + 1} fois sans effet : tenu, plus d'écriture avant un nouveau clic ou que le panneau l'affiche`,
      ),
      watch: both('applied, watched for a late command', 'appliqué, surveillé (commande tardive)'),
    };
    const s = states[state] ?? states.waiting;
    return both(
      `Stop (${what.en}) of ${name}: ${s.en}.`,
      `Arrêt (${what.fr}) de ${name} : ${s.fr}.`,
    );
  },
  test: {
    notSooner: (wait) =>
      both(
        `(Not read again: the next read is in ${wait.en}, never sooner than the interval.)`,
        `(Pas relu : la prochaine lecture est dans ${wait.fr}, jamais avant l'intervalle.)`,
      ),
  },
};

/** The answers of refused or uncertain commands (shown in Gladys, logged). */
export const ERRORS = {
  readOnly: both(
    'This feature takes no command.',
    'Cette fonctionnalité ne prend aucune commande.',
  ),
  badValue: both('Invalid value for this feature.', 'Valeur invalide pour cette fonctionnalité.'),
  disabled: (option) =>
    both(
      `Commands of ${option.en} are not allowed (configuration of the integration). Turning off always works.`,
      `Les commandes de ${option.fr} ne sont pas autorisées (configuration de l'intégration). L'arrêt fonctionne toujours.`,
    ),
  wouldHeat: both(
    'Turning this on may start the heating of a body (heat mode not off): heating must be allowed too.',
    "Cette mise en marche peut lancer le chauffage d'un bassin (mode de chauffage différent de Arrêt) : le chauffage doit aussi être autorisé.",
  ),
  noAddress: both(
    'No panel address known: nothing sent yet; kept, sent first as soon as an address is known.',
    "Aucune adresse de panneau connue : rien envoyé pour le moment ; gardé, envoyé en premier dès qu'une adresse est connue.",
  ),
  notReadYet: both(
    'The configuration is not read yet: nothing sent.',
    "La configuration n'est pas encore lue : rien envoyé.",
  ),
  unknownPanel: both(
    'The panel of this feature is not the one read: nothing sent.',
    "Le panneau de cette fonctionnalité n'est pas celui qui est lu : rien envoyé.",
  ),
  otherPanel: both(
    'Another panel answers at this address: nothing sent.',
    'Un autre panneau répond à cette adresse : rien envoyé.',
  ),
  unknownObject: both(
    'The panel does not show this object: nothing sent.',
    "Le panneau n'affiche pas cet objet : rien envoyé.",
  ),
  unknownState: (reason) =>
    both(
      `The state of the panel cannot be read (${reason}): nothing sent.`,
      `L'état du panneau ne peut pas être lu (${reason}) : rien envoyé.`,
    ),
  unknownUnit: both(
    'The temperature unit of the panel cannot be read: nothing sent.',
    "L'unité de température du panneau ne peut pas être lue : rien envoyé.",
  ),
  outOfBounds: (low, high) =>
    both(
      `Set point out of bounds: ${decimal(low, 'en')} to ${decimal(high, 'en')} °C. Nothing sent.`,
      `Consigne hors bornes : ${decimal(low, 'fr')} à ${decimal(high, 'fr')} °C. Rien envoyé.`,
    ),
  setpointAbove: (name, celsius, ceiling) =>
    both(
      `Heating of ${name} not started: the set point it holds (${decimal(celsius, 'en')} °C) is above its ceiling (${decimal(ceiling, 'en')} °C). Lower the set point first; nothing sent.`,
      `Chauffage de ${name} non lancé : la consigne qu'il garde (${decimal(celsius, 'fr')} °C) dépasse son plafond (${decimal(ceiling, 'fr')} °C). Baissez d'abord la consigne ; rien envoyé.`,
    ),
  setpointUnreadable: (name) =>
    both(
      `Heating of ${name} not started: the set point it holds cannot be read, so it cannot be checked against its ceiling. Nothing sent.`,
      `Chauffage de ${name} non lancé : la consigne qu'il garde est illisible, elle ne peut pas être comparée à son plafond. Rien envoyé.`,
    ),
  stopInProgress: both(
    'A stop of this body is in progress (not seen applied): set the heat mode first, nothing sent.',
    "Un arrêt de ce bassin est en cours (pas encore vu appliqué) : réglez d'abord le mode de chauffage, rien envoyé.",
  ),
  stopMeanwhile: both(
    'A stop was clicked meanwhile: this command was not sent.',
    "Un arrêt a été cliqué entre-temps : cette commande n'a pas été envoyée.",
  ),
  replaced: both(
    'A newer command for the same setting replaced it: not sent.',
    'Une commande plus récente du même réglage la remplace : non envoyée.',
  ),
  tooSlow: both(
    'The panel did not give its turn in time: nothing sent.',
    "Le panneau n'a pas donné son tour à temps : rien envoyé.",
  ),
  notSent: (reason) => both(`Nothing sent (${reason}).`, `Rien envoyé (${reason}).`),
  refused: (reason) =>
    both(`The panel refused it (${reason}).`, `Le panneau l'a refusé (${reason}).`),
  sentUnconfirmed: (reason) =>
    both(
      `Sent, without confirmation (${reason}): the panel is read again in 5 s.`,
      `Envoyé, sans confirmation (${reason}) : le panneau est relu dans 5 s.`,
    ),
  notApplied: both(
    'Sent, not applied yet: the panel still shows the state before. Read again in 5 s.',
    "Envoyé, pas encore appliqué : le panneau montre encore l'état d'avant. Relu dans 5 s.",
  ),
  sentDiffers: both(
    'Sent, but the panel shows another value: read again in 5 s.',
    'Envoyé, mais le panneau affiche une autre valeur : relu dans 5 s.',
  ),
  stopNotSent: (reason) =>
    both(
      `Stop not sent yet (${reason}): kept, tried again every 15 s and at each read.`,
      `Arrêt pas encore envoyé (${reason}) : gardé, réessayé toutes les 15 s et à chaque lecture.`,
    ),
  stopRefused: (reason) =>
    both(
      `Stop refused by the panel (${reason}): kept, written again after 15 s, then less and less often (up to every 5 min), without end.`,
      `Arrêt refusé par le panneau (${reason}) : gardé, réécrit après 15 s, puis de plus en plus espacé (jusqu'à toutes les 5 min), sans fin.`,
    ),
  stopUnconfirmed: both(
    'Stop sent, without confirmation yet: kept and checked every 15 s.',
    'Arrêt envoyé, sans confirmation pour le moment : gardé et vérifié toutes les 15 s.',
  ),
  stopStillHeating: both(
    'Heating stop written and shown by the panel, but the body still heats: watched (check on the panel if it does not end within 2 minutes).',
    "Arrêt du chauffage écrit et affiché par le panneau, mais le bassin chauffe encore : surveillé (vérifiez sur le panneau s'il ne cesse pas d'ici 2 minutes).",
  ),
  stopNotApplied: both(
    'Stop sent, not applied yet: kept, checked every 15 s and written again 15 s after each write (3 times at most).',
    'Arrêt envoyé, pas encore appliqué : gardé, vérifié toutes les 15 s et réécrit 15 s après chaque écriture (3 fois au plus).',
  ),
};
