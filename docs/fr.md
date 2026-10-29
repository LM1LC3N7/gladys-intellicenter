# Pentair IntelliCenter pour Gladys

Affiche votre panneau de piscine **Pentair IntelliCenter** (i5P, i7+3, i8PS,
i10PS, i10+3D) dans Gladys par son **protocole local** (TCP, port 6681) : sans
cloud, sans compte, directement sur votre réseau.

> **Jamais testé avec un vrai panneau.** Sans lien avec Pentair.
> L'intégration suit la bibliothèque pyintellicenter (MIT). Une mise à jour
> du firmware du panneau peut changer le protocole. ScreenLogic n'est pas pris
> en charge.

## Ce que vous obtenez

Un appareil par panneau (repéré par le nom unique de son système, pas par son
adresse IP), avec, pour chaque objet que le panneau montre :

| Objet                                | Fonctionnalités                                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| Bassin (piscine, spa)                | Température de l'eau, consigne de chauffage, mode de chauffage (liste), chauffe en cours |
| Circuit (piscine, spa, mis en avant) | Marche / arrêt (liste)                                                                   |
| Éclairage                            | Marche / arrêt (liste)                                                                   |
| Pompe                                | En marche, vitesse (tr/min), puissance (W)                                               |
| Sonde (air, solaire, eau)            | Température                                                                              |
| IntelliChem                          | pH, redox (ORP, mV), consignes de pH et de redox (lecture seule)                         |
| IntelliChlor                         | Sel (ppm)                                                                                |

Plus une fonctionnalité **État** (connecté ou injoignable). Les circuits non
mis en avant (les « Aux » inutilisés) ne sont pas affichés.

- Les températures sont en °C : un panneau réglé en °F est converti
  exactement ((°F − 32) × 5 / 9). Si l'unité du panneau ne peut pas être lue,
  aucune température n'est publiée.
- La température de l'eau d'un bassin n'est publiée que pendant qu'il tourne
  (pompe en marche) : à l'arrêt, le panneau garde une valeur ancienne.
- Une valeur inconnue, vide ou à 0 quand 0 veut dire « non disponible » (pH,
  redox, sel) n'est jamais publiée.

Lecture toutes les 30 secondes par défaut (de 15 s à 10 min, réglable), une
requête à la fois, sur une seule connexion.

## Installation

1. Donnez une adresse IP fixe au panneau dans votre box.
2. Dans Gladys, installez l'intégration et saisissez l'adresse IP du panneau
   (ou son nom d'hôte, éventuellement suivi d'un port).
3. Enregistrez, puis ajoutez le panneau depuis l'onglet **Découverte**.

Le panneau n'a pas d'identifiants : rien de secret n'est configuré.

## Arrêter (toujours disponible)

Choisir **Arrêt** sur un circuit (ou un éclairage), ou **Arrêt** dans le mode
de chauffage d'un bassin, ne dépend d'aucune option, ni d'une lecture ou d'une
commande en cours (il les interrompt et part sur une nouvelle connexion), ni
d'une lecture qui a échoué, ni de la configuration : juste après un
redémarrage, il part vers l'adresse du dernier panneau lu (gardée dans
`/data`), et un arrêt pas encore vu appliqué avant un redémarrage est renvoyé
dès le démarrage du conteneur. Une commande arrivée avant lui et pas encore
partie est abandonnée. Plusieurs arrêts cliqués ensemble partent dans une
seule écriture.

Il est réussi quand la relecture du panneau le montre (pour l'arrêt du
chauffage : le mode Arrêt **et** plus de chauffe en cours). Sinon la réponse
dit pourquoi, et l'arrêt est gardé (dans `/data`) et vérifié toutes les 15 s
(chaque adresse de panneau a sa propre vérification) et à chaque lecture :

- **aucune adresse connue** (ni configuration ni panneau lu auparavant) :
  rien n'est envoyé pour le moment ; l'arrêt est gardé en mémoire et part en
  premier dès qu'une adresse est connue ;
- **le panneau ne répond pas** (3 s d'essais, toutes les 250 ms) : réessayé
  à chaque vérification (15 s), à chaque lecture qui atteint le panneau et au
  clic sur **Tester la connexion** ; un arrêt qui n'est jamais parti n'est
  jamais abandonné ;
- **refusé par le panneau** (un code autre que 200) : réécrit après 15 s,
  puis de plus en plus espacé (30 s, 1, 2, 4 min, puis toutes les 5 min),
  sans fin ; un refus ne compte pas comme écriture ;
- **pas encore appliqué** (le panneau ne le montre pas) : réécrit 15 s après
  chaque écriture, au plus 3 fois (écritures acceptées par le panneau), puis
  tenu sans nouvelle écriture, ce que l'état de l'intégration dit ;
- **sans confirmation** à temps (4,3 s) : vérifié de la même façon ;
- **arrêt du chauffage affiché mais le bassin chauffe encore** (le panneau
  montre le mode Arrêt, mais signale encore une chauffe) : surveillé, rien
  n'est réécrit ; c'est normal pendant un refroidissement, mais au-delà de
  2 minutes l'état de l'intégration demande de vérifier sur le panneau (le
  mode Arrêt écrit vient de pyintellicenter et n'a pas été vérifié sur un
  vrai panneau) ; si le panneau ne donne pas son état de chauffe, l'état de
  l'intégration le dit (« état de chauffe illisible ») et l'arrêt reste
  surveillé.

L'état de l'intégration dit où en est chaque arrêt : pas encore envoyé,
envoyé en attente de relecture, refusé (avec le code), tenu, chauffe encore,
ou surveillé. Si le panneau change d'adresse (même panneau lu à la nouvelle),
ses arrêts gardés le suivent.

Un arrêt gardé est levé quand le panneau le montre, ou quand une commande du
même réglage cliquée dans Gladys après lui (option activée) est partie sans
refus du panneau (une absence de réponse le lève aussi : la commande a pu
s'appliquer). Un nouveau clic sur Arrêt le réécrit et recompte ses écritures.
Un arrêt gardé dans `/data` avant un redémarrage est levé de même, sans être
envoyé, quand une telle commande de son réglage est partie depuis le démarrage
(un `/data` lent à lire est appliqué à la fin de sa lecture). Jamais par le
temps. Une commande partie moins de 30 s avant l'arrêt et appliquée après
lui est contrée par une nouvelle écriture. Tant que l'arrêt
du chauffage d'un bassin n'est pas vu appliqué, sa consigne, la mise en
marche de son circuit et celle d'un groupe de circuits sont refusées. Un
bassin « chauffe » tant que son mode n'est pas vu sur Arrêt **ou** que le
panneau signale encore une chauffe (illisible compte comme chauffe).

## Mettre en marche et chauffer (options)

Trois options, **désactivées par défaut** :

- **Autoriser la mise en marche des circuits et pompes** : les circuits qui
  ne sont pas des éclairages (piscine, spa et leurs pompes, circuits mis en
  avant). Mettre en marche une piscine ou un spa qui chauffe (mode de
  chauffage pas vu sur Arrêt, ou chauffe encore signalée) exige aussi
  l'option chauffage (sa pompe démarre, et avec elle son chauffage). Un
  **groupe de circuits** (« Spa Mode »…) peut allumer un bassin : il exige
  l'option chauffage tant qu'un des bassins chauffe ou qu'aucun bassin n'a
  encore été lu.
- **Autoriser l'allumage des éclairages**.
- **Autoriser le chauffage** : choisir une source de chauffage, régler la
  consigne. Un **spa est limité à 40 °C**, une piscine au plafond de la
  configuration (35 °C par défaut, 40 °C au plus). La borne est vérifiée sur
  la valeur écrite (un degré entier), après la conversion en °F quand le
  panneau est en °F : 40 °C = 104 °F ; le bas est 4 °C (40 °F).

Ce sont des listes et une consigne, jamais un interrupteur : un « tout
éteindre » ne les atteint pas. Chaque commande relit le panneau juste avant
(identité, objets, unité), revérifie les options juste avant d'écrire, part
dans les 3,5 s ou pas du tout, et n'est réussie que si la relecture montre la
valeur demandée (« envoyé, pas encore appliqué » sinon, puis relectures à 5
et 20 s). Les commandes arrivées ensemble (une scène) partent dans une seule
écriture. Refusées aussi : avant la lecture de la configuration, si un autre
panneau répond à l'adresse, ou si un arrêt a été cliqué entre-temps.

## Bon à savoir

- Le panneau n'est jamais lu avant l'intervalle : ni par le bouton **Tester
  la connexion**, ni par une Découverte, ni après une reconnexion à Gladys ou
  un redémarrage (l'heure de la dernière lecture est gardée dans `/data`).
  Seules les relectures qui suivent une commande ou un clic sur Arrêt (5 et
  20 s) et les vérifications d'un arrêt gardé (toutes les 15 s, qui ne lisent
  que les objets de l'arrêt) font exception.
- Une valeur de plus de 2 minutes n'est jamais renvoyée comme nouvelle.
- Les consignes de la chimie (pH, redox), la vitesse des pompes, les
  spectacles de lumière et les programmes sont en lecture seule ou absents
  dans cette version.
- L'application Pentair, l'écran du panneau et ses programmes peuvent aussi
  le piloter : la dernière écriture gagne.
