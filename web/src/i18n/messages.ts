// Interface copy only. Source job text and user queries never pass through this catalogue.
import type { InterfaceLocale } from './locales.ts';

export const messages = {
  "{current} newly observed listing, compared with {previous} the previous week": [
    "{current} neu erfasste Stellenanzeige, gegenüber {previous} in der Vorwoche",
    "{current} nouvelle offre repérée, contre {previous} la semaine précédente",
    "{current} nuovo annuncio rilevato, rispetto a {previous} la settimana precedente",
    "{current} nueva oferta detectada, frente a {previous} la semana anterior"
  ],
  "{current} newly observed listings, compared with {previous} the previous week": [
    "{current} neu erfasste Stellenanzeigen, gegenüber {previous} in der Vorwoche",
    "{current} nouvelles offres repérées, contre {previous} la semaine précédente",
    "{current} nuovi annunci rilevati, rispetto a {previous} la settimana precedente",
    "{current} nuevas ofertas detectadas, frente a {previous} la semana anterior"
  ],
  "Last checked": ["Zuletzt geprüft", "Dernière vérification", "Ultima verifica", "Última comprobación"],
  "Your visitor search session expired. Reconnect to start a new search.": ["Deine Besuchersitzung ist abgelaufen. Verbinde dich erneut, um eine neue Suche zu starten.", "Ta session de recherche visiteur a expiré. Reconnecte-toi pour lancer une nouvelle recherche.", "La sessione di ricerca visitatore è scaduta. Riconnettiti per iniziare una nuova ricerca.", "Tu sesión de búsqueda de visitante ha caducado. Vuelve a conectarte para iniciar una nueva búsqueda."],
  "Your earlier check was interrupted. Submit this text when you want to try again.": ["Deine vorige Prüfung wurde unterbrochen. Sende diesen Text, wenn du es erneut versuchen möchtest.", "La vérification précédente a été interrompue. Envoie ce texte quand tu souhaites réessayer.", "La verifica precedente è stata interrotta. Invia questo testo quando vuoi riprovare.", "La comprobación anterior se interrumpió. Envía este texto cuando quieras volver a intentarlo."],
  "Sign in to keep your searches and continue.": ["Melde dich an, um deine Suchen zu behalten und fortzufahren.", "Connecte-toi pour conserver tes recherches et continuer.", "Accedi per conservare le tue ricerche e continuare.", "Inicia sesión para conservar tus búsquedas y continuar."],
  "Sign in to continue": ["Anmelden und fortfahren", "Se connecter pour continuer", "Accedi per continuare", "Inicia sesión para continuar"],
  "Viewed": ["Angesehen", "Consultée", "Visualizzata", "Vista"],
  "Retry saving": ["Speichern erneut versuchen", "Réessayer l’enregistrement", "Riprova a salvare", "Volver a guardar"],
  "Review draft conflict": ["Entwurfskonflikt prüfen", "Examiner le conflit de brouillons", "Esamina il conflitto tra bozze", "Revisar el conflicto de borradores"],
  "This workspace changed in another tab. Your unsaved text is still in the search field.": ["Dieser Arbeitsbereich wurde in einem anderen Tab geändert. Dein ungespeicherter Text steht noch im Suchfeld.", "Cet espace a changé dans un autre onglet. Ton texte non enregistré est toujours dans le champ de recherche.", "Questo spazio è cambiato in un’altra scheda. Il testo non salvato è ancora nel campo di ricerca.", "Este espacio cambió en otra pestaña. Tu texto sin guardar sigue en el campo de búsqueda."],
  "A search was deleted in another tab. Its edits cannot be saved to that search. Copy any text you want to keep before using the saved copy.": ["Eine Suche wurde in einem anderen Tab gelöscht. Ihre Änderungen können dort nicht gespeichert werden. Kopiere den Text, den du behalten möchtest, bevor du die gespeicherte Fassung verwendest.", "Une recherche a été supprimée dans un autre onglet. Ses modifications ne peuvent plus y être enregistrées. Copie le texte à conserver avant d’utiliser la version enregistrée.", "Una ricerca è stata eliminata in un’altra scheda. Le modifiche non possono essere salvate in quella ricerca. Copia il testo da conservare prima di usare la versione salvata.", "Se eliminó una búsqueda en otra pestaña. Sus cambios no se pueden guardar en esa búsqueda. Copia el texto que quieras conservar antes de usar la copia guardada."],
  "Deleted search": ["Gelöschte Suche", "Recherche supprimée", "Ricerca eliminata", "Búsqueda eliminada"],
  "Empty draft": ["Leerer Entwurf", "Brouillon vide", "Bozza vuota", "Borrador vacío"],
  "Copy text from {title}": ["Text aus {title} kopieren", "Copier le texte de {title}", "Copia il testo di {title}", "Copiar el texto de {title}"],
  "Copied. You can paste this text into a new search after loading the saved copy.": ["Kopiert. Nach dem Laden der gespeicherten Fassung kannst du den Text in eine neue Suche einfügen.", "Copié. Tu peux coller ce texte dans une nouvelle recherche après avoir chargé la version enregistrée.", "Copiato. Puoi incollare questo testo in una nuova ricerca dopo aver caricato la versione salvata.", "Copiado. Puedes pegar este texto en una búsqueda nueva después de cargar la copia guardada."],
  "Copying is unavailable. Select the text above and copy it before loading the saved copy.": ["Kopieren ist nicht verfügbar. Markiere den Text oben und kopiere ihn, bevor du die gespeicherte Fassung lädst.", "La copie est indisponible. Sélectionne le texte ci-dessus et copie-le avant de charger la version enregistrée.", "La copia non è disponibile. Seleziona e copia il testo sopra prima di caricare la versione salvata.", "No se puede copiar automáticamente. Selecciona y copia el texto de arriba antes de cargar la copia guardada."],
  "Review the saved copy": ["Gespeicherte Fassung prüfen", "Examiner la version enregistrée", "Esamina la versione salvata", "Revisar la copia guardada"],
  "Keep my edits": ["Meine Änderungen behalten", "Conserver mes modifications", "Mantieni le mie modifiche", "Conservar mis cambios"],
  "Use saved copy and discard these edits": ["Gespeicherte Fassung verwenden und diese Änderungen verwerfen", "Utiliser la version enregistrée et abandonner ces modifications", "Usa la versione salvata e scarta queste modifiche", "Usar la copia guardada y descartar estos cambios"],
  "{count} saved draft": ["{count} gespeicherter Entwurf", "{count} brouillon enregistré", "{count} bozza salvata", "{count} borrador guardado"],
  "{count} saved drafts": ["{count} gespeicherte Entwürfe", "{count} brouillons enregistrés", "{count} bozze salvate", "{count} borradores guardados"],
  "Use this draft": ["Diesen Entwurf verwenden", "Utiliser ce brouillon", "Usa questa bozza", "Usar este borrador"],
  "Discard this saved draft": ["Diesen gespeicherten Entwurf verwerfen", "Supprimer ce brouillon enregistré", "Scarta questa bozza salvata", "Descartar este borrador guardado"],
  "Discard this saved draft?": ["Diesen gespeicherten Entwurf verwerfen?", "Supprimer ce brouillon enregistré ?", "Scartare questa bozza salvata?", "¿Descartar este borrador guardado?"],
  "This removes only the saved draft you selected. Your other searches and drafts stay saved.": ["Nur der ausgewählte gespeicherte Entwurf wird entfernt. Deine anderen Suchen und Entwürfe bleiben gespeichert.", "Seul le brouillon enregistré sélectionné sera supprimé. Tes autres recherches et brouillons restent enregistrés.", "Viene rimossa solo la bozza salvata selezionata. Le altre ricerche e bozze restano salvate.", "Solo se elimina el borrador guardado que seleccionaste. Tus demás búsquedas y borradores se conservan."],
  "Keep draft": ["Entwurf behalten", "Conserver le brouillon", "Mantieni la bozza", "Conservar borrador"],
  "Discard draft": ["Entwurf verwerfen", "Supprimer le brouillon", "Scarta la bozza", "Descartar borrador"],
  "Saved workspace unavailable.": ["Gespeicherter Arbeitsbereich nicht verfügbar.", "Espace enregistré indisponible.", "Spazio salvato non disponibile.", "Espacio guardado no disponible."],
  "Viewed status is not synced yet.": ["Der Gesehen-Status ist noch nicht synchronisiert.", "L’état de consultation n’est pas encore synchronisé.", "Lo stato di visualizzazione non è ancora sincronizzato.", "El estado de lectura aún no está sincronizado."],
  "This position is no longer available to sync.": ["Diese Stelle kann nicht mehr synchronisiert werden.", "Cette offre ne peut plus être synchronisée.", "Questa posizione non può più essere sincronizzata.", "Esta oferta ya no se puede sincronizar."],
  "Reconnect the saved workspace before continuing.": ["Verbinde den gespeicherten Arbeitsbereich erneut, bevor du fortfährst.", "Reconnecte l’espace enregistré avant de continuer.", "Riconnetti lo spazio salvato prima di continuare.", "Vuelve a conectar el espacio guardado antes de continuar."],
  "Review the draft conflict before continuing. Your unsaved text is still here.": ["Prüfe den Entwurfskonflikt, bevor du fortfährst. Dein ungespeicherter Text ist noch hier.", "Examine le conflit de brouillons avant de continuer. Ton texte non enregistré est toujours ici.", "Esamina il conflitto tra bozze prima di continuare. Il testo non salvato è ancora qui.", "Revisa el conflicto de borradores antes de continuar. Tu texto sin guardar sigue aquí."],
  "This workspace changed in another tab. Review both copies before saving.": ["Dieser Arbeitsbereich wurde in einem anderen Tab geändert. Prüfe beide Fassungen vor dem Speichern.", "Cet espace a changé dans un autre onglet. Examine les deux versions avant d’enregistrer.", "Questo spazio è cambiato in un’altra scheda. Esamina entrambe le versioni prima di salvare.", "Este espacio cambió en otra pestaña. Revisa ambas copias antes de guardar."],
  "Your latest edits are still being saved. Please try again.": ["Deine neuesten Änderungen werden noch gespeichert. Bitte versuche es erneut.", "Tes dernières modifications sont encore en cours d’enregistrement. Réessaie.", "Le ultime modifiche sono ancora in fase di salvataggio. Riprova.", "Tus últimos cambios aún se están guardando. Inténtalo de nuevo."],
  "Checking the existing search…": ["Bestehende Suche wird geprüft…", "Vérification de la recherche existante…", "Verifica della ricerca esistente…", "Comprobando la búsqueda existente…"],
  "Reconnect before changing saved searches.": ["Verbinde dich erneut, bevor du gespeicherte Suchen änderst.", "Reconnecte-toi avant de modifier les recherches enregistrées.", "Riconnettiti prima di modificare le ricerche salvate.", "Vuelve a conectarte antes de modificar las búsquedas guardadas."],
  "Search storage is unavailable. Reconnect before signing in to keep this draft.": ["Der Suchspeicher ist nicht verfügbar. Verbinde dich vor der Anmeldung erneut, um diesen Entwurf zu behalten.", "Le stockage des recherches est indisponible. Reconnecte-toi avant de te connecter au compte pour conserver ce brouillon.", "L’archivio delle ricerche non è disponibile. Riconnettiti prima di accedere per conservare questa bozza.", "El almacenamiento de búsquedas no está disponible. Vuelve a conectarte antes de iniciar sesión para conservar este borrador."],
  "Company listing activity, week ending {date}": ["Aktivität der Firmenstellenanzeigen, Woche bis {date}", "Activité des offres des entreprises, semaine se terminant le {date}", "Attività degli annunci aziendali, settimana conclusa il {date}", "Actividad de ofertas de empresas, semana que termina el {date}"],
  "Newly observed listings: {previous} previous week, {current} current week": ["Neu erfasste Stellenanzeigen: {previous} in der Vorwoche, {current} in der aktuellen Woche", "Nouvelles offres repérées : {previous} la semaine précédente, {current} cette semaine", "Nuovi annunci rilevati: {previous} la settimana precedente, {current} questa settimana", "Nuevas ofertas detectadas: {previous} la semana anterior, {current} esta semana"],
  "Newly observed listings changed {change}; {previous} previous week, {current} current week": ["Änderung neu erfasster Stellenanzeigen: {change}; {previous} in der Vorwoche, {current} in der aktuellen Woche", "Évolution des nouvelles offres repérées : {change} ; {previous} la semaine précédente, {current} cette semaine", "Variazione dei nuovi annunci rilevati: {change}; {previous} la settimana precedente, {current} questa settimana", "Cambio en las nuevas ofertas detectadas: {change}; {previous} la semana anterior, {current} esta semana"],
  "Processing is unavailable until policies are approved for this language.": [
    "Die Verarbeitung ist erst verfügbar, wenn die Hinweise für diese Sprache freigegeben sind.",
    "Le traitement est indisponible tant que les notices ne sont pas approuvées pour cette langue.",
    "L’elaborazione non è disponibile finché le informative non sono approvate per questa lingua.",
    "El procesamiento no está disponible hasta que se aprueben los avisos para este idioma."
  ],
  "Processing is paused until current policy and data protections are available.": [
    "Die Verarbeitung pausiert, bis die aktuellen Hinweise und Datenschutzmaßnahmen verfügbar sind.",
    "Le traitement est suspendu jusqu’à la disponibilité des notices et des protections des données actuelles.",
    "L’elaborazione è sospesa finché non sono disponibili le informative e le protezioni dei dati aggiornate.",
    "El procesamiento está en pausa hasta que estén disponibles los avisos y las protecciones de datos actuales."
  ],
  "Verify your account to activate the free period.": [
    "Bestätige dein Konto, um den kostenlosen Zeitraum zu aktivieren.",
    "Vérifie ton compte pour activer la période gratuite.",
    "Verifica il tuo account per attivare il periodo gratuito.",
    "Verifica tu cuenta para activar el periodo gratuito."
  ],
  "The free period is unavailable.": [
    "Der kostenlose Zeitraum ist nicht verfügbar.",
    "La période gratuite est indisponible.",
    "Il periodo gratuito non è disponibile.",
    "El periodo gratuito no está disponible."
  ],
  "Choose a supported interface language.": [
    "Wähle eine unterstützte Sprache für die Oberfläche.",
    "Choisis une langue d’interface prise en charge.",
    "Scegli una lingua dell’interfaccia supportata.",
    "Elige un idioma de interfaz compatible."
  ],

"For account access, the reviewed notices are in {language}.": ["Für den Kontozugriff gelten die geprüften Hinweise auf {language}.", "Pour l’accès au compte, les notices validées sont en {language}.", "Per accedere all’account, le informative approvate sono in {language}.", "Para acceder a la cuenta, los avisos revisados están en {language}."],
"Your language preference changed elsewhere. Review your saved choice and try again.": ["Deine Spracheinstellung wurde anderswo geändert. Prüfe deine gespeicherte Auswahl und versuche es erneut.", "Ta préférence de langue a changé ailleurs. Vérifie ton choix enregistré et réessaie.", "La preferenza di lingua è cambiata altrove. Controlla la scelta salvata e riprova.", "Tu preferencia de idioma cambió en otro lugar. Revisa tu elección guardada e inténtalo de nuevo."],
  "More companies ↗": [
    "Weitere Firmen ↗",
    "Plus d’entreprises ↗",
    "Altre aziende ↗",
    "Más empresas ↗"
  ],
  "Reload directory": [
    "Verzeichnis neu laden",
    "Recharger le répertoire",
    "Ricarica il catalogo",
    "Recargar el catálogo"
  ],
  "Reload directory ↗": [
    "Verzeichnis neu laden ↗",
    "Recharger le répertoire ↗",
    "Ricarica il catalogo ↗",
    "Recargar el catálogo ↗"
  ],
  "The company directory changed. Reload the directory to continue.": [
    "Das Firmenverzeichnis hat sich geändert. Lade es neu, um fortzufahren.",
    "Le répertoire des entreprises a changé. Recharge-le pour continuer.",
    "Il catalogo aziende è cambiato. Ricaricalo per continuare.",
    "El catálogo de empresas ha cambiado. Recárgalo para continuar."
  ],
  "The company directory could not be verified. Please try again shortly.": [
    "Das Firmenverzeichnis konnte nicht überprüft werden. Versuche es in Kürze erneut.",
    "Le répertoire des entreprises n’a pas pu être vérifié. Réessaie dans un instant.",
    "Non è stato possibile verificare il catalogo aziende. Riprova tra poco.",
    "No se pudo verificar el catálogo de empresas. Inténtalo de nuevo en unos instantes."
  ],

  "Fresh jobs. Clear sources.": [
    "Frische Stellen. Klare Quellen.",
    "Offres récentes. Sources claires.",
    "Offerte fresche. Fonti chiare.",
    "Ofertas recientes. Fuentes claras."
  ],
  "Page not found": [
    "Seite nicht gefunden",
    "Page introuvable",
    "Pagina non trovata",
    "Página no encontrada"
  ],
  "Coverage temporarily unavailable": [
    "Abdeckung vorübergehend nicht verfügbar",
    "Couverture temporairement indisponible",
    "Copertura temporaneamente non disponibile",
    "Cobertura no disponible temporalmente"
  ],
  "Find fresh jobs first observed in the last 14 days. Original employer sources, no paid placement, and transparent company coverage.": [
    "Finde aktuelle Stellen, die wir in den letzten 14 Tagen erstmals gesehen haben. Originalquellen der Arbeitgeber, keine bezahlte Platzierung und transparente Firmenabdeckung.",
    "Trouve des offres repérées pour la première fois dans les 14 derniers jours. Sources employeurs originales, aucun placement payant et couverture transparente des entreprises.",
    "Trova offerte rilevate per la prima volta negli ultimi 14 giorni. Fonti originali dei datori di lavoro, nessun posizionamento a pagamento e copertura trasparente delle aziende.",
    "Encuentra ofertas vistas por primera vez en los últimos 14 días. Fuentes originales de las empresas, sin posiciones de pago y con cobertura transparente."
  ],
  "Browse the companies included in Justup and see the career pages we track. Coverage is reported openly; request a missing company.": [
    "Durchsuche die Firmen auf Justup und sieh dir die erfassten Karriereseiten an. Die Abdeckung wird offen ausgewiesen; schlage eine fehlende Firma vor.",
    "Parcours les entreprises incluses dans Justup et leurs pages carrière suivies. La couverture est indiquée ouvertement ; demande une entreprise manquante.",
    "Esplora le aziende incluse in Justup e le pagine carriere che seguiamo. La copertura è dichiarata apertamente; richiedi un’azienda mancante.",
    "Explora las empresas incluidas en Justup y las páginas de empleo que seguimos. La cobertura se indica abiertamente; solicita una empresa que falte."
  ],

  "{count} position still awaiting requirement checks.": [
    "{count} Stelle wartet noch auf die Anforderungsprüfung.",
    "{count} poste attend encore la vérification des critères.",
    "{count} posizione attende ancora la verifica dei requisiti.",
    "{count} oferta sigue pendiente de comprobar requisitos."
  ],
  "{count} check failed. This position is not included.": [
    "{count} Prüfung fehlgeschlagen. Diese Stelle ist nicht enthalten.",
    "{count} vérification a échoué. Ce poste n’est pas inclus.",
    "{count} verifica non riuscita. Questa posizione non è inclusa.",
    "{count} comprobación fallida. Esta oferta no se incluye."
  ],
  "{count} position lacks enough evidence to confirm a match.": [
    "Bei {count} Stelle fehlen Belege, um eine Übereinstimmung zu bestätigen.",
    "Pour {count} poste, les preuves ne suffisent pas à confirmer la correspondance.",
    "Per {count} posizione mancano elementi sufficienti per confermare la corrispondenza.",
    "{count} oferta no tiene pruebas suficientes para confirmar la coincidencia."
  ],

  "Invalid request.": [
    "Ungültige Anfrage.",
    "Demande non valide.",
    "Richiesta non valida.",
    "Solicitud no válida."
  ],
  "Invalid username, password or invite code.": [
    "Ungültiger Benutzername, Passwort oder Einladungscode.",
    "Nom d’utilisateur, mot de passe ou code d’invitation incorrect.",
    "Nome utente, password o codice d’invito non valido.",
    "Usuario, contraseña o código de invitación incorrecto."
  ],
  "Registration is closed.": [
    "Die Registrierung ist geschlossen.",
    "Les inscriptions sont fermées.",
    "Le registrazioni sono chiuse.",
    "El registro está cerrado."
  ],
  "The account limit has been reached.": [
    "Die Kontogrenze ist erreicht.",
    "La limite de comptes a été atteinte.",
    "Il limite di account è stato raggiunto.",
    "Se ha alcanzado el límite de cuentas."
  ],
  "That username is unavailable.": [
    "Dieser Benutzername ist nicht verfügbar.",
    "Ce nom d’utilisateur n’est pas disponible.",
    "Questo nome utente non è disponibile.",
    "Ese nombre de usuario no está disponible."
  ],
  "Sign in to continue.": [
    "Melde dich an, um fortzufahren.",
    "Connecte-toi pour continuer.",
    "Accedi per continuare.",
    "Inicia sesión para continuar."
  ],
  "Account access is unavailable until policies are approved.": [
    "Der Kontozugriff ist bis zur Freigabe der Hinweise nicht verfügbar.",
    "L’accès au compte est indisponible jusqu’à l’approbation des notices.",
    "L’accesso all’account non è disponibile fino all’approvazione delle informative.",
    "El acceso a la cuenta no está disponible hasta que se aprueben los avisos."
  ],
  "Account access is temporarily unavailable.": [
    "Der Kontozugriff ist vorübergehend nicht verfügbar.",
    "L’accès au compte est temporairement indisponible.",
    "L’accesso all’account è temporaneamente non disponibile.",
    "El acceso a la cuenta no está disponible temporalmente."
  ],
  "This request is not allowed.": [
    "Diese Anfrage ist nicht erlaubt.",
    "Cette demande n’est pas autorisée.",
    "Questa richiesta non è consentita.",
    "Esta solicitud no está permitida."
  ],
  "Send a bounded JSON object.": [
    "Sende ein JSON-Objekt innerhalb der Größenbegrenzung.",
    "Envoie un objet JSON respectant la limite de taille.",
    "Invia un oggetto JSON entro il limite di dimensione.",
    "Envía un objeto JSON dentro del límite de tamaño."
  ],
  "Not found.": [
    "Nicht gefunden.",
    "Introuvable.",
    "Non trovato.",
    "No encontrado."
  ],
  "Too many requests. Try again later.": [
    "Zu viele Anfragen. Versuche es später erneut.",
    "Trop de demandes. Réessaie plus tard.",
    "Troppe richieste. Riprova più tardi.",
    "Demasiadas solicitudes. Inténtalo más tarde."
  ],
  "The task limit has been reached.": [
    "Die Aufgabengrenze ist erreicht.",
    "La limite de tâches a été atteinte.",
    "Il limite di attività è stato raggiunto.",
    "Se ha alcanzado el límite de tareas."
  ],
  "This request key was already used.": [
    "Dieser Anfrageschlüssel wurde bereits verwendet.",
    "Cette clé de demande a déjà été utilisée.",
    "Questa chiave di richiesta è già stata utilizzata.",
    "Esta clave de solicitud ya se ha utilizado."
  ],
  "This feed changed. Reload it and try again.": [
    "Diese Ergebnisliste hat sich geändert. Lade sie neu und versuche es erneut.",
    "Cette liste a changé. Recharge-la et réessaie.",
    "Questo elenco è cambiato. Ricaricalo e riprova.",
    "Esta lista ha cambiado. Recárgala e inténtalo de nuevo."
  ],
  "Invalid cursor.": [
    "Ungültiger Ergebniscursor.",
    "Curseur de résultats non valide.",
    "Cursore dei risultati non valido.",
    "Cursor de resultados no válido."
  ],
  "Invalid page size.": [
    "Ungültige Ergebnisanzahl.",
    "Taille de page non valide.",
    "Dimensione della pagina non valida.",
    "Tamaño de página no válido."
  ],
  "Invalid query.": [
    "Ungültige Suchanfrage.",
    "Recherche non valide.",
    "Ricerca non valida.",
    "Búsqueda no válida."
  ],
  "This feature is temporarily unavailable.": [
    "Diese Funktion ist vorübergehend nicht verfügbar.",
    "Cette fonctionnalité est temporairement indisponible.",
    "Questa funzione non è temporaneamente disponibile.",
    "Esta función no está disponible temporalmente."
  ],
  "This search changed. Reload it and try again.": [
    "Diese Suche hat sich geändert. Lade sie neu und versuche es erneut.",
    "Cette recherche a changé. Recharge-la et réessaie.",
    "Questa ricerca è cambiata. Ricaricala e riprova.",
    "Esta búsqueda ha cambiado. Recárgala e inténtalo de nuevo."
  ],
  "This preview changed. Reload it and try again.": [
    "Diese Vorschau hat sich geändert. Lade sie neu und versuche es erneut.",
    "Cet aperçu a changé. Recharge-le et réessaie.",
    "Questa anteprima è cambiata. Ricaricala e riprova.",
    "Esta vista previa ha cambiado. Recárgala e inténtalo de nuevo."
  ],
  "Some requirements are unsupported.": [
    "Einige Anforderungen werden nicht unterstützt.",
    "Certains critères ne sont pas pris en charge.",
    "Alcuni requisiti non sono supportati.",
    "Algunos requisitos no son compatibles."
  ],
  "The request could not be completed.": [
    "Die Anfrage konnte nicht abgeschlossen werden.",
    "La demande n’a pas pu aboutir.",
    "Impossibile completare la richiesta.",
    "No se pudo completar la solicitud."
  ],
  "This task could not finish.": [
    "Diese Aufgabe konnte nicht abgeschlossen werden.",
    "Cette tâche n’a pas pu se terminer.",
    "Impossibile completare questa attività.",
    "No se pudo completar esta tarea."
  ],
  "Paid access remains active until the paid period ends.": [
    "Der bezahlte Zugang bleibt bis zum Ende des bezahlten Zeitraums aktiv.",
    "L’accès payant reste actif jusqu’à la fin de la période payée.",
    "L’accesso a pagamento resta attivo fino alla fine del periodo pagato.",
    "El acceso de pago sigue activo hasta el final del periodo pagado."
  ],
  "Payment needs attention; access remains active until the paid period ends.": [
    "Die Zahlung muss geprüft werden; der Zugang bleibt bis zum Ende des bezahlten Zeitraums aktiv.",
    "Le paiement nécessite ton attention ; l’accès reste actif jusqu’à la fin de la période payée.",
    "Il pagamento richiede attenzione; l’accesso resta attivo fino alla fine del periodo pagato.",
    "El pago requiere atención; el acceso sigue activo hasta el final del periodo pagado."
  ],
  "Paid access is active.": [
    "Der bezahlte Zugang ist aktiv.",
    "L’accès payant est actif.",
    "L’accesso a pagamento è attivo.",
    "El acceso de pago está activo."
  ],
  "Free access is active.": [
    "Der kostenlose Zugang ist aktiv.",
    "L’accès gratuit est actif.",
    "L’accesso gratuito è attivo.",
    "El acceso gratuito está activo."
  ],
  "Payment status is being checked.": [
    "Der Zahlungsstatus wird geprüft.",
    "Le statut du paiement est en cours de vérification.",
    "Lo stato del pagamento è in verifica.",
    "Se está comprobando el estado del pago."
  ],
  "Your free period has ended.": [
    "Dein kostenloser Zeitraum ist abgelaufen.",
    "Ta période gratuite est terminée.",
    "Il tuo periodo gratuito è terminato.",
    "Tu periodo gratuito ha terminado."
  ],
  "Paid access has ended.": [
    "Der bezahlte Zugang ist abgelaufen.",
    "L’accès payant est terminé.",
    "L’accesso a pagamento è terminato.",
    "El acceso de pago ha terminado."
  ],
  "Your free period is ready to start.": [
    "Dein kostenloser Zeitraum kann beginnen.",
    "Ta période gratuite est prête à commencer.",
    "Il tuo periodo gratuito è pronto per iniziare.",
    "Tu periodo gratuito está listo para empezar."
  ],
  "Verify your account to start your free period.": [
    "Bestätige dein Konto, um deinen kostenlosen Zeitraum zu starten.",
    "Vérifie ton compte pour commencer ta période gratuite.",
    "Verifica il tuo account per iniziare il periodo gratuito.",
    "Verifica tu cuenta para empezar tu periodo gratuito."
  ],

"Interface preferences are unavailable.": ["Spracheinstellungen sind nicht verfügbar.", "Les préférences de langue sont indisponibles.", "Le preferenze di lingua non sono disponibili.", "Las preferencias de idioma no están disponibles."],
  "Checking every requirement…": [
    "Jede Anforderung wird geprüft…",
    "Vérification de chaque critère…",
    "Verifica di ogni requisito…",
    "Comprobando cada requisito…"
  ],
  "Search saved.": [
    "Suche gespeichert.",
    "Recherche enregistrée.",
    "Ricerca salvata.",
    "Búsqueda guardada."
  ],
  "Search saved with your confirmed limitations.": [
    "Suche mit deinen bestätigten Einschränkungen gespeichert.",
    "Recherche enregistrée avec les limites que tu as confirmées.",
    "Ricerca salvata con i limiti confermati.",
    "Búsqueda guardada con las limitaciones que has confirmado."
  ],
  "Your newer edits have not been applied.": [
    "Deine neueren Änderungen wurden nicht angewendet.",
    "Tes modifications les plus récentes n’ont pas été appliquées.",
    "Le modifiche più recenti non sono state applicate.",
    "No se han aplicado tus cambios más recientes."
  ],
  "Saved searches unavailable.": [
    "Gespeicherte Suchen nicht verfügbar.",
    "Recherches enregistrées indisponibles.",
    "Ricerche salvate non disponibili.",
    "Búsquedas guardadas no disponibles."
  ],
  "The last accepted revision and its results are unchanged.": [
    "Die zuletzt bestätigte Version und ihre Ergebnisse sind unverändert.",
    "La dernière version validée et ses résultats restent inchangés.",
    "L’ultima versione confermata e i suoi risultati restano invariati.",
    "La última versión aceptada y sus resultados no han cambiado."
  ],
  "The last accepted search is unchanged.": [
    "Die zuletzt bestätigte Suche ist unverändert.",
    "La dernière recherche validée reste inchangée.",
    "L’ultima ricerca confermata resta invariata.",
    "La última búsqueda aceptada no ha cambiado."
  ],
  "The earlier search needs clarification. Submit your updated text to continue.": [
    "Die vorherige Suche benötigt eine Klarstellung. Sende deinen aktualisierten Text, um fortzufahren.",
    "La recherche précédente doit être précisée. Envoie ton texte actualisé pour continuer.",
    "La ricerca precedente richiede un chiarimento. Invia il testo aggiornato per continuare.",
    "La búsqueda anterior necesita aclaración. Envía el texto actualizado para continuar."
  ],
  "The service returned a different search. Please reconnect.": [
    "Der Dienst hat eine andere Suche zurückgegeben. Verbinde dich erneut.",
    "Le service a renvoyé une autre recherche. Reconnecte-toi.",
    "Il servizio ha restituito una ricerca diversa. Riconnettiti.",
    "El servicio ha devuelto otra búsqueda. Reconecta."
  ],
  "The service returned an outdated proposal. Please retry.": [
    "Der Dienst hat einen veralteten Vorschlag zurückgegeben. Versuche es erneut.",
    "Le service a renvoyé une proposition obsolète. Réessaie.",
    "Il servizio ha restituito una proposta obsoleta. Riprova.",
    "El servicio ha devuelto una propuesta antigua. Inténtalo de nuevo."
  ],
  "The service returned an unexpected search revision. Please reconnect.": [
    "Der Dienst hat eine unerwartete Suchversion zurückgegeben. Verbinde dich erneut.",
    "Le service a renvoyé une version inattendue de la recherche. Reconnecte-toi.",
    "Il servizio ha restituito una versione inattesa della ricerca. Riconnettiti.",
    "El servicio ha devuelto una versión inesperada de la búsqueda. Reconecta."
  ],
  "The search task returned an unrelated result.": [
    "Die Suchaufgabe hat ein unpassendes Ergebnis zurückgegeben.",
    "La recherche a renvoyé un résultat sans rapport.",
    "La ricerca ha restituito un risultato non pertinente.",
    "La búsqueda ha devuelto un resultado no relacionado."
  ],
  "The service returned an unexpected confirmed revision.": [
    "Der Dienst hat eine unerwartete bestätigte Version zurückgegeben.",
    "Le service a renvoyé une version validée inattendue.",
    "Il servizio ha restituito una versione confermata inattesa.",
    "El servicio ha devuelto una versión confirmada inesperada."
  ],
  "The company check returned an unexpected result. Please try another lead.": [
    "Die Firmenprüfung ergab ein unerwartetes Ergebnis. Versuche einen anderen Hinweis.",
    "La vérification de l’entreprise a renvoyé un résultat inattendu. Essaie une autre piste.",
    "La verifica dell’azienda ha restituito un risultato inatteso. Prova un’altra segnalazione.",
    "La comprobación de la empresa ha devuelto un resultado inesperado. Prueba otra pista."
  ],
  "This request is no longer available.": [
    "Diese Anfrage ist nicht mehr verfügbar.",
    "Cette demande n’est plus disponible.",
    "Questa richiesta non è più disponibile.",
    "Esta solicitud ya no está disponible."
  ],
  "Please reconnect before trying again.": [
    "Bitte verbinde dich erneut, bevor du es noch einmal versuchst.",
    "Reconnecte-toi avant de réessayer.",
    "Riconnettiti prima di riprovare.",
    "Reconecta antes de intentarlo de nuevo."
  ],
  "The request timed out. Please try again.": [
    "Die Anfrage hat zu lange gedauert. Versuche es erneut.",
    "La requête a expiré. Réessaie.",
    "La richiesta è scaduta. Riprova.",
    "La solicitud ha agotado el tiempo de espera. Inténtalo de nuevo."
  ],
  "The service is unavailable. Your accepted search has been kept.": [
    "Der Dienst ist nicht verfügbar. Deine bestätigte Suche bleibt erhalten.",
    "Le service est indisponible. Ta recherche validée a été conservée.",
    "Il servizio non è disponibile. La ricerca confermata è stata conservata.",
    "El servicio no está disponible. Se ha conservado tu búsqueda aceptada."
  ],
  "The service is unavailable. Please try again.": [
    "Der Dienst ist nicht verfügbar. Versuche es erneut.",
    "Le service est indisponible. Réessaie.",
    "Il servizio non è disponibile. Riprova.",
    "El servicio no está disponible. Inténtalo de nuevo."
  ],
  "The service returned an unreadable response. Please retry.": [
    "Der Dienst hat eine unlesbare Antwort zurückgegeben. Versuche es erneut.",
    "Le service a renvoyé une réponse illisible. Réessaie.",
    "Il servizio ha restituito una risposta illeggibile. Riprova.",
    "El servicio ha devuelto una respuesta ilegible. Inténtalo de nuevo."
  ],
  "The service could not complete this request.": [
    "Der Dienst konnte diese Anfrage nicht abschließen.",
    "Le service n’a pas pu terminer cette demande.",
    "Il servizio non è riuscito a completare la richiesta.",
    "El servicio no pudo completar esta solicitud."
  ],
  "The service returned a different task. Please retry.": [
    "Der Dienst hat eine andere Aufgabe zurückgegeben. Versuche es erneut.",
    "Le service a renvoyé une autre tâche. Réessaie.",
    "Il servizio ha restituito un’attività diversa. Riprova.",
    "El servicio ha devuelto otra tarea. Inténtalo de nuevo."
  ],
  "The background check failed. Please try again.": [
    "Die Prüfung ist fehlgeschlagen. Versuche es erneut.",
    "La vérification a échoué. Réessaie.",
    "La verifica non è riuscita. Riprova.",
    "La comprobación ha fallado. Inténtalo de nuevo."
  ],
  "The check is still pending. Retry to resume the same task.": [
    "Die Prüfung läuft noch. Versuche es erneut, um dieselbe Aufgabe fortzusetzen.",
    "La vérification est en attente. Réessaie pour reprendre la même tâche.",
    "La verifica è ancora in attesa. Riprova per riprendere la stessa attività.",
    "La comprobación sigue pendiente. Inténtalo de nuevo para reanudar la misma tarea."
  ],
  "Try again after {seconds} seconds.": [
    "Versuche es nach {seconds} Sekunden erneut.",
    "Réessaie dans {seconds} secondes.",
    "Riprova tra {seconds} secondi.",
    "Inténtalo de nuevo dentro de {seconds} segundos."
  ],
  "Reference: {reference}.": [
    "Referenz: {reference}.",
    "Référence : {reference}.",
    "Riferimento: {reference}.",
    "Referencia: {reference}."
  ],

"Company catalogue": ["Firmenkatalog", "Catalogue des entreprises", "Catalogo aziende", "Catálogo de empresas"],
  "(optional)": [
    "(optional)",
    "(facultatif)",
    "(facoltativo)",
    "(opcional)"
  ],
  "+ New search": [
    "+ Neue Suche",
    "+ Nouvelle recherche",
    "+ Nuova ricerca",
    "+ Nueva búsqueda"
  ],
  "A little more to go on.": [
    "Noch ein paar Angaben.",
    "Quelques précisions.",
    "Qualche dettaglio in più.",
    "Un poco más de información."
  ],
  "A name. We’ll check the facts.": [
    "Ein Name. Wir prüfen die Fakten.",
    "Un nom. Nous vérifierons les faits.",
    "Un nome. Verifichiamo i fatti.",
    "Un nombre. Comprobaremos los datos."
  ],
  "A particular division or career page": [
    "Eine bestimmte Sparte oder Karriereseite",
    "Une filiale ou une page carrières précise",
    "Una divisione o pagina carriere specifica",
    "Una división o página de empleo concreta"
  ],
  "Accept these limitations": [
    "Diese Einschränkungen akzeptieren",
    "Accepter ces limites",
    "Accetta queste limitazioni",
    "Aceptar estas limitaciones"
  ],
  "All companies": [
    "Alle Unternehmen",
    "Toutes les entreprises",
    "Tutte le aziende",
    "Todas las empresas"
  ],
  "At the source.": [
    "Direkt an der Quelle.",
    "À la source.",
    "Alla fonte.",
    "En la fuente."
  ],
  "Back to search ↗": [
    "Zurück zur Suche ↗",
    "Retour à la recherche ↗",
    "Torna alla ricerca ↗",
    "Volver a la búsqueda ↗"
  ],
  "Back to top": [
    "Nach oben",
    "Retour en haut",
    "Torna in alto",
    "Volver arriba"
  ],
  "Be as specific as you need. We’ll show how your requirements are handled.": [
    "Sei so genau wie nötig. Wir zeigen dir, wie deine Anforderungen berücksichtigt werden.",
    "Soyez aussi précis que nécessaire. Nous indiquerons comment vos critères sont pris en compte.",
    "Specifica tutti i dettagli che vuoi. Ti mostreremo come vengono considerati i tuoi requisiti.",
    "Sé tan específico como necesites. Mostraremos cómo se tienen en cuenta tus requisitos."
  ],
  "Beat the": [
    "Schluss mit",
    "Fini",
    "Basta",
    "Adiós"
  ],
  "Before signing in, read our": [
    "Lies vor der Anmeldung unsere",
    "Avant de vous connecter, lisez notre",
    "Prima di accedere, leggi",
    "Antes de iniciar sesión, lee nuestra"
  ],
  "Browse included companies": [
    "Enthaltene Unternehmen ansehen",
    "Voir les entreprises incluses",
    "Esplora le aziende incluse",
    "Ver las empresas incluidas"
  ],
  "Cancel deleting search": [
    "Löschen der Suche abbrechen",
    "Annuler la suppression de la recherche",
    "Annulla l’eliminazione della ricerca",
    "Cancelar la eliminación de la búsqueda"
  ],
  "Check again": [
    "Erneut prüfen",
    "Vérifier à nouveau",
    "Controlla di nuovo",
    "Comprobar de nuevo"
  ],
  "Check company website ↗": [
    "Unternehmenswebsite prüfen ↗",
    "Consulter le site de l’entreprise ↗",
    "Consulta il sito dell’azienda ↗",
    "Consultar la web de la empresa ↗"
  ],
  "Check for new positions": [
    "Nach neuen Stellen suchen",
    "Vérifier les nouvelles offres",
    "Controlla le nuove posizioni",
    "Comprobar nuevas ofertas"
  ],
  "Checking the lead.": [
    "Wir prüfen den Hinweis.",
    "Vérification de la piste.",
    "Verifica della segnalazione.",
    "Comprobando la pista."
  ],
  "Clear sources.": [
    "Klare Quellen.",
    "Des sources claires.",
    "Fonti chiare.",
    "Fuentes claras."
  ],
  "Close settings": [
    "Einstellungen schließen",
    "Fermer les paramètres",
    "Chiudi le impostazioni",
    "Cerrar la configuración"
  ],
  "Close sign in": [
    "Anmeldung schließen",
    "Fermer la connexion",
    "Chiudi l’accesso",
    "Cerrar el inicio de sesión"
  ],
  "Companies": [
    "Unternehmen",
    "Entreprises",
    "Aziende",
    "Empresas"
  ],
  "Company catalogue ↗": [
    "Unternehmensverzeichnis ↗",
    "Catalogue des entreprises ↗",
    "Catalogo delle aziende ↗",
    "Catálogo de empresas ↗"
  ],
  "Company found · please confirm": [
    "Unternehmen gefunden · bitte bestätigen",
    "Entreprise trouvée · à confirmer",
    "Azienda trovata · conferma",
    "Empresa encontrada · confirma"
  ],
  "Company name or website": [
    "Unternehmensname oder Website",
    "Nom ou site de l’entreprise",
    "Nome o sito dell’azienda",
    "Nombre o web de la empresa"
  ],
  "Company requests are unavailable right now. Please try again later.": [
    "Unternehmensanfragen sind gerade nicht verfügbar. Bitte versuche es später erneut.",
    "Les demandes d’entreprise sont momentanément indisponibles. Réessayez plus tard.",
    "Le richieste di aziende non sono disponibili al momento. Riprova più tardi.",
    "Las solicitudes de empresas no están disponibles ahora. Inténtalo más tarde."
  ],
  "Confirm it’s the one": [
    "Das richtige Unternehmen bestätigen",
    "Confirmez la bonne entreprise",
    "Conferma che è quella giusta",
    "Confirma que es la correcta"
  ],
  "Confirm your password": [
    "Passwort bestätigen",
    "Confirmez votre mot de passe",
    "Conferma la password",
    "Confirma tu contraseña"
  ],
  "Continue ↗": [
    "Weiter ↗",
    "Continuer ↗",
    "Continua ↗",
    "Continuar ↗"
  ],
  "Create an account": [
    "Konto erstellen",
    "Créer un compte",
    "Crea un account",
    "Crear una cuenta"
  ],
  "Delete account": [
    "Konto löschen",
    "Supprimer le compte",
    "Elimina l’account",
    "Eliminar la cuenta"
  ],
  "Delete search": [
    "Suche löschen",
    "Supprimer la recherche",
    "Elimina la ricerca",
    "Eliminar la búsqueda"
  ],
  "Delete this search?": [
    "Diese Suche löschen?",
    "Supprimer cette recherche ?",
    "Eliminare questa ricerca?",
    "¿Eliminar esta búsqueda?"
  ],
  "Delete your account?": [
    "Dein Konto löschen?",
    "Supprimer votre compte ?",
    "Eliminare il tuo account?",
    "¿Eliminar tu cuenta?"
  ],
  "Direct from employer": [
    "Direkt vom Arbeitgeber",
    "Directement de l’employeur",
    "Direttamente dal datore di lavoro",
    "Directamente del empleador"
  ],
  "Employer / source": [
    "Arbeitgeber / Quelle",
    "Employeur / source",
    "Datore di lavoro / fonte",
    "Empleador / fuente"
  ],
  "English interface": [
    "Deutsche Oberfläche",
    "Interface en français",
    "Interfaccia in italiano",
    "Interfaz en español"
  ],
  "Every company in our catalogue. On the record.": [
    "Jedes Unternehmen in unserem Verzeichnis. Transparent aufgeführt.",
    "Toutes les entreprises de notre catalogue. En toute transparence.",
    "Tutte le aziende del nostro catalogo. In chiaro.",
    "Todas las empresas de nuestro catálogo. Con transparencia."
  ],
  "Find a company": [
    "Unternehmen finden",
    "Trouver une entreprise",
    "Trova un’azienda",
    "Buscar una empresa"
  ],
  "Find company ↗": [
    "Unternehmen finden ↗",
    "Trouver l’entreprise ↗",
    "Trova l’azienda ↗",
    "Buscar empresa ↗"
  ],
  "First seen": [
    "Zuerst entdeckt",
    "Première observation",
    "Prima osservazione",
    "Primera observación"
  ],
  "Following your lead…": [
    "Wir gehen deinem Hinweis nach…",
    "Nous suivons votre piste…",
    "Seguiamo la tua segnalazione…",
    "Siguiendo tu pista…"
  ],
  "Fresh jobs.": [
    "Frische Jobs.",
    "Des offres récentes.",
    "Offerte recenti.",
    "Ofertas recientes."
  ],
  "Fresh listings from company career pages. See exactly which companies are included.": [
    "Frische Stellenanzeigen von den Karriereseiten der Unternehmen. Sieh genau, welche Unternehmen dabei sind.",
    "Des offres récentes issues des pages carrières des entreprises. Voyez exactement lesquelles sont incluses.",
    "Offerte recenti dalle pagine carriere delle aziende. Scopri esattamente quali aziende sono incluse.",
    "Ofertas recientes de las páginas de empleo de las empresas. Consulta exactamente cuáles están incluidas."
  ],
  "Fresh work.": [
    "Frische Jobs.",
    "Des offres récentes.",
    "Lavoro fresco.",
    "Empleo reciente."
  ],
  "Fresh work. Clear sources.": [
    "Frische Jobs. Klare Quellen.",
    "Des offres récentes. Des sources claires.",
    "Lavoro fresco. Fonti chiare.",
    "Empleo reciente. Fuentes claras."
  ],
  "Give us a lead. You’ll confirm the company before we record your request.": [
    "Gib uns einen Hinweis. Du bestätigst das Unternehmen, bevor wir deine Anfrage speichern.",
    "Donnez-nous une piste. Vous confirmerez l’entreprise avant l’enregistrement de votre demande.",
    "Lasciaci una segnalazione. Confermerai l’azienda prima che registriamo la richiesta.",
    "Danos una pista. Confirmarás la empresa antes de que registremos tu solicitud."
  ],
  "Good coverage starts with being clear about it.": [
    "Gute Abdeckung beginnt mit Transparenz.",
    "Une bonne couverture commence par la transparence.",
    "Una buona copertura parte dalla trasparenza.",
    "Una buena cobertura empieza por la transparencia."
  ],
  "Help grow the edition.": [
    "Hilf, die Ausgabe zu erweitern.",
    "Aidez-nous à enrichir l’édition.",
    "Aiutaci ad ampliare l’edizione.",
    "Ayuda a ampliar la edición."
  ],
  "Hiring over time.": [
    "Stellen im Zeitverlauf.",
    "Les offres dans le temps.",
    "Offerte nel tempo.",
    "Ofertas a lo largo del tiempo."
  ],
  "Hiring report": [
    "Stellenbericht",
    "Rapport de recrutement",
    "Rapporto sulle offerte",
    "Informe de empleo"
  ],
  "Hiring roles.": [
    "Gesuchte Berufe.",
    "Postes recherchés.",
    "Ruoli ricercati.",
    "Puestos buscados."
  ],
  "Historical hiring": [
    "Historische Stellenaktivität",
    "Historique des offres",
    "Storico delle offerte",
    "Historial de ofertas"
  ],
  "Historical hiring data is not available for this company.": [
    "Für dieses Unternehmen liegen keine historischen Stellendaten vor.",
    "Aucun historique des offres n’est disponible pour cette entreprise.",
    "I dati storici sulle offerte di questa azienda non sono disponibili.",
    "No hay datos históricos de ofertas para esta empresa."
  ],
  "Interface language: English.": [
    "Sprache der Oberfläche: Deutsch.",
    "Langue de l’interface : français.",
    "Lingua dell’interfaccia: italiano.",
    "Idioma de la interfaz: español."
  ],
  "Invitation code": [
    "Einladungscode",
    "Code d’invitation",
    "Codice di invito",
    "Código de invitación"
  ],
  "Just in.": [
    "Gerade eingetroffen.",
    "À l’instant.",
    "Appena arrivate.",
    "Recién llegadas."
  ],
  "Justup home": [
    "Justup Startseite",
    "Accueil Justup",
    "Home di Justup",
    "Inicio de Justup"
  ],
  "Keep account": [
    "Konto behalten",
    "Conserver le compte",
    "Mantieni l’account",
    "Conservar la cuenta"
  ],
  "Keep search": [
    "Suche behalten",
    "Conserver la recherche",
    "Mantieni la ricerca",
    "Conservar la búsqueda"
  ],
  "Last 14 days": [
    "Letzte 14 Tage",
    "14 derniers jours",
    "Ultimi 14 giorni",
    "Últimos 14 días"
  ],
  "Last successful check": [
    "Letzte erfolgreiche Prüfung",
    "Dernière vérification réussie",
    "Ultima verifica riuscita",
    "Última comprobación correcta"
  ],
  "Legal": [
    "Rechtliches",
    "Informations légales",
    "Informazioni legali",
    "Información legal"
  ],
  "Listing activity reported by the source data.": [
    "In den Quelldaten erfasste Stellenaktivität.",
    "Activité des offres indiquée par les données sources.",
    "Attività delle offerte riportata dai dati di origine.",
    "Actividad de ofertas registrada en los datos de origen."
  ],
  "Main navigation": [
    "Hauptnavigation",
    "Navigation principale",
    "Navigazione principale",
    "Navegación principal"
  ],
  "Monitoring since": [
    "Erfasst seit",
    "Suivi depuis",
    "Monitorata dal",
    "Seguimiento desde"
  ],
  "More details": [
    "Weitere Angaben",
    "Plus de détails",
    "Altri dettagli",
    "Más detalles"
  ],
  "More in this edition": [
    "Mehr in dieser Ausgabe",
    "Plus dans cette édition",
    "Altro in questa edizione",
    "Más en esta edición"
  ],
  "Name, website or industry": [
    "Name, Website oder Branche",
    "Nom, site ou secteur",
    "Nome, sito o settore",
    "Nombre, web o sector"
  ],
  "New": [
    "Neu",
    "Nouveau",
    "Nuovo",
    "Nueva"
  ],
  "Newest first": [
    "Neueste zuerst",
    "Plus récentes d’abord",
    "Prima le più recenti",
    "Más recientes primero"
  ],
  "No confirmed match.": [
    "Kein bestätigter Treffer.",
    "Aucune correspondance confirmée.",
    "Nessuna corrispondenza confermata.",
    "No hay coincidencia confirmada."
  ],
  "No paid placement.": [
    "Keine bezahlten Plätze.",
    "Sans placement payant.",
    "Nessuna posizione a pagamento.",
    "Sin posiciones de pago."
  ],
  "No tracked career pages reported.": [
    "Keine erfassten Karriereseiten gemeldet.",
    "Aucune page carrières suivie n’est indiquée.",
    "Nessuna pagina carriere monitorata indicata.",
    "No se indican páginas de empleo seguidas."
  ],
  "Not met:": [
    "Nicht erfüllt:",
    "Non satisfait :",
    "Non soddisfatto:",
    "No cumplido:"
  ],
  "Not this company": [
    "Nicht dieses Unternehmen",
    "Ce n’est pas cette entreprise",
    "Non è questa azienda",
    "No es esta empresa"
  ],
  "On the record.": [
    "Festgehalten.",
    "C’est enregistré.",
    "Agli atti.",
    "Queda registrado."
  ],
  "One good lead at a time.": [
    "Ein guter Hinweis nach dem anderen.",
    "Une bonne piste à la fois.",
    "Una buona segnalazione alla volta.",
    "Una buena pista cada vez."
  ],
  "Open": [
    "Öffnen",
    "Ouvrir",
    "Apri",
    "Abrir"
  ],
  "Opening the company report…": [
    "Unternehmensbericht wird geöffnet…",
    "Ouverture du rapport de l’entreprise…",
    "Apertura del rapporto dell’azienda…",
    "Abriendo el informe de la empresa…"
  ],
  "Page not found.": [
    "Seite nicht gefunden.",
    "Page introuvable.",
    "Pagina non trovata.",
    "Página no encontrada."
  ],
  "Password": [
    "Passwort",
    "Mot de passe",
    "Password",
    "Contraseña"
  ],
  "Payments are not enabled.": [
    "Zahlungen sind nicht aktiviert.",
    "Les paiements ne sont pas activés.",
    "I pagamenti non sono attivi.",
    "Los pagos no están habilitados."
  ],
  "Position": [
    "Stelle",
    "Poste",
    "Posizione",
    "Puesto"
  ],
  "Positions": [
    "Stellen",
    "Offres",
    "Posizioni",
    "Ofertas"
  ],
  "Privacy": [
    "Datenschutz",
    "Confidentialité",
    "Privacy",
    "Privacidad"
  ],
  "Privacy notice": [
    "Datenschutzhinweise",
    "Notice de confidentialité",
    "Informativa sulla privacy",
    "Aviso de privacidad"
  ],
  "Reconnect": [
    "Neu verbinden",
    "Reconnecter",
    "Riconnetti",
    "Reconectar"
  ],
  "Reduce motion": [
    "Bewegungen reduzieren",
    "Réduire les animations",
    "Riduci le animazioni",
    "Reducir el movimiento"
  ],
  "Report unavailable.": [
    "Bericht nicht verfügbar.",
    "Rapport indisponible.",
    "Rapporto non disponibile.",
    "Informe no disponible."
  ],
  "Reported salaries.": [
    "Gemeldete Gehälter.",
    "Salaires indiqués.",
    "Retribuzioni indicate.",
    "Salarios indicados."
  ],
  "Request a company": [
    "Unternehmen anfragen",
    "Demander une entreprise",
    "Richiedi un’azienda",
    "Solicitar una empresa"
  ],
  "Request a company +": [
    "Unternehmen anfragen +",
    "Demander une entreprise +",
    "Richiedi un’azienda +",
    "Solicitar una empresa +"
  ],
  "Request recorded": [
    "Anfrage gespeichert",
    "Demande enregistrée",
    "Richiesta registrata",
    "Solicitud registrada"
  ],
  "Request this company ↗": [
    "Dieses Unternehmen anfragen ↗",
    "Demander cette entreprise ↗",
    "Richiedi questa azienda ↗",
    "Solicitar esta empresa ↗"
  ],
  "Request unavailable.": [
    "Anfrage nicht verfügbar.",
    "Demande indisponible.",
    "Richiesta non disponibile.",
    "Solicitud no disponible."
  ],
  "Retry": [
    "Erneut versuchen",
    "Réessayer",
    "Riprova",
    "Reintentar"
  ],
  "Saved searches": [
    "Gespeicherte Suchen",
    "Recherches enregistrées",
    "Ricerche salvate",
    "Búsquedas guardadas"
  ],
  "Search": [
    "Suchen",
    "Rechercher",
    "Cerca",
    "Buscar"
  ],
  "Send us a lead": [
    "Gib uns einen Hinweis",
    "Donnez-nous une piste",
    "Lasciaci una segnalazione",
    "Danos una pista"
  ],
  "Send us a lead ↗": [
    "Gib uns einen Hinweis ↗",
    "Donnez-nous une piste ↗",
    "Lasciaci una segnalazione ↗",
    "Danos una pista ↗"
  ],
  "Settings": [
    "Einstellungen",
    "Paramètres",
    "Impostazioni",
    "Configuración"
  ],
  "Sign in": [
    "Anmelden",
    "Se connecter",
    "Accedi",
    "Iniciar sesión"
  ],
  "Sign out": [
    "Abmelden",
    "Se déconnecter",
    "Esci",
    "Cerrar sesión"
  ],
  "Skip to content": [
    "Zum Inhalt",
    "Aller au contenu",
    "Vai al contenuto",
    "Ir al contenido"
  ],
  "Start again": [
    "Neu beginnen",
    "Recommencer",
    "Ricomincia",
    "Empezar de nuevo"
  ],
  "Still checking for matching positions…": [
    "Passende Stellen werden weiter geprüft…",
    "Vérification des offres correspondantes…",
    "Verifica delle posizioni corrispondenti…",
    "Seguimos comprobando ofertas coincidentes…"
  ],
  "THE JUSTUP WAY": [
    "SO GEHT JUSTUP",
    "LA MÉTHODE JUSTUP",
    "IL METODO JUSTUP",
    "EL MÉTODO JUSTUP"
  ],
  "The service returned an unknown request state.": [
    "Der Dienst hat einen unbekannten Anfragestatus zurückgegeben.",
    "Le service a renvoyé un état de demande inconnu.",
    "Il servizio ha restituito uno stato di richiesta sconosciuto.",
    "El servicio devolvió un estado de solicitud desconocido."
  ],
  "The sources.": [
    "Die Quellen.",
    "Les sources.",
    "Le fonti.",
    "Las fuentes."
  ],
  "This requests deletion of your account and saved data. Read the": [
    "Damit beantragst du die Löschung deines Kontos und deiner gespeicherten Daten. Lies die",
    "Cela demande la suppression de votre compte et de vos données enregistrées. Consultez les",
    "Questa azione richiede l’eliminazione dell’account e dei dati salvati. Leggi le",
    "Esto solicita la eliminación de tu cuenta y tus datos guardados. Lee las"
  ],
  "This search needs your decision.": [
    "Diese Suche braucht deine Entscheidung.",
    "Cette recherche nécessite votre décision.",
    "Questa ricerca richiede una tua decisione.",
    "Esta búsqueda necesita tu decisión."
  ],
  "Try again": [
    "Erneut versuchen",
    "Réessayer",
    "Riprova",
    "Intentar de nuevo"
  ],
  "Try another lead": [
    "Anderen Hinweis versuchen",
    "Essayer une autre piste",
    "Prova un’altra segnalazione",
    "Probar otra pista"
  ],
  "Usage": [
    "Nutzung",
    "Utilisation",
    "Utilizzo",
    "Uso"
  ],
  "Usage terms": [
    "Nutzungsbedingungen",
    "Conditions d’utilisation",
    "Condizioni d’uso",
    "Condiciones de uso"
  ],
  "Username": [
    "Benutzername",
    "Nom d’utilisateur",
    "Nome utente",
    "Nombre de usuario"
  ],
  "View company ↗": [
    "Unternehmen ansehen ↗",
    "Voir l’entreprise ↗",
    "Visualizza l’azienda ↗",
    "Ver empresa ↗"
  ],
  "WANTED": [
    "GESUCHT",
    "RECHERCHÉ",
    "CERCASI",
    "SE BUSCA"
  ],
  "Website, industry, or the full name": [
    "Website, Branche oder vollständiger Name",
    "Site, secteur ou nom complet",
    "Sito, settore o nome completo",
    "Web, sector o nombre completo"
  ],
  "We’re looking for the right company. You’ll confirm the match before we record it.": [
    "Wir suchen das richtige Unternehmen. Du bestätigst den Treffer, bevor wir ihn speichern.",
    "Nous recherchons la bonne entreprise. Vous la confirmerez avant son enregistrement.",
    "Cerchiamo l’azienda giusta. Confermerai la corrispondenza prima che venga registrata.",
    "Buscamos la empresa correcta. Confirmarás la coincidencia antes de que la registremos."
  ],
  "What to include": [
    "Was soll erfasst werden?",
    "Que faut-il inclure ?",
    "Cosa includere",
    "Qué incluir"
  ],
  "YOUR FIRST SEARCH": [
    "DEINE ERSTE SUCHE",
    "VOTRE PREMIÈRE RECHERCHE",
    "LA TUA PRIMA RICERCA",
    "TU PRIMERA BÚSQUEDA"
  ],
  "YOUR SEARCHES": [
    "DEINE SUCHEN",
    "VOS RECHERCHES",
    "LE TUE RICERCHE",
    "TUS BÚSQUEDAS"
  ],
  "Yes, that’s the one ↗": [
    "Ja, das ist es ↗",
    "Oui, c’est la bonne ↗",
    "Sì, è quella giusta ↗",
    "Sí, es la correcta ↗"
  ],
  "Your Justup edition": [
    "Deine Justup-Ausgabe",
    "Votre édition Justup",
    "La tua edizione Justup",
    "Tu edición Justup"
  ],
  "Your account": [
    "Dein Konto",
    "Votre compte",
    "Il tuo account",
    "Tu cuenta"
  ],
  "Your edition": [
    "Deine Ausgabe",
    "Votre édition",
    "La tua edizione",
    "Tu edición"
  ],
  "Your edition awaits.": [
    "Deine Ausgabe wartet.",
    "Votre édition vous attend.",
    "La tua edizione ti aspetta.",
    "Tu edición te espera."
  ],
  "Your edition.": [
    "Deine Ausgabe.",
    "Votre édition.",
    "La tua edizione.",
    "Tu edición."
  ],
  "Your next role could be": [
    "Dein nächster Job könnte",
    "Votre prochain poste pourrait être",
    "Il tuo prossimo lavoro potrebbe essere",
    "Tu próximo puesto podría estar"
  ],
  "and": [
    "und",
    "et",
    "e",
    "y"
  ],
  "at a company we don’t": [
    "bei einem Unternehmen sein,",
    "dans une entreprise que nous",
    "in un’azienda che non",
    "en una empresa que aún"
  ],
  "endless scroll.": [
    "dem endlosen Scrollen.",
    "le défilement sans fin.",
    "scorrere senza fine.",
    "al desplazamiento sin fin."
  ],
  "for retention details.": [
    "für Einzelheiten zur Aufbewahrung.",
    "pour les détails de conservation.",
    "per i dettagli sulla conservazione.",
    "para conocer los detalles de conservación."
  ],
  "know about. Yet.": [
    "das wir noch nicht kennen. Noch.",
    "ne connaissons pas. Encore.",
    "conosciamo. Per ora.",
    "no conocemos. Todavía."
  ],
  "← Back to search": [
    "← Zurück zur Suche",
    "← Retour à la recherche",
    "← Torna alla ricerca",
    "← Volver a la búsqueda"
  ],
  "← Company catalogue": [
    "← Unternehmensverzeichnis",
    "← Catalogue des entreprises",
    "← Catalogo delle aziende",
    "← Catálogo de empresas"
  ],
  "Interface language": [
    "Sprache der Oberfläche",
    "Langue de l’interface",
    "Lingua dell’interfaccia",
    "Idioma de la interfaz"
  ],
  "Browser default": [
    "Browsereinstellung",
    "Langue du navigateur",
    "Lingua del browser",
    "Idioma del navegador"
  ],
  "CONNECTING": [
    "VERBINDEN",
    "CONNEXION",
    "CONNESSIONE",
    "CONECTANDO"
  ],
  "LIVE EDITION": [
    "LIVE-AUSGABE",
    "ÉDITION EN DIRECT",
    "EDIZIONE IN DIRETTA",
    "EDICIÓN EN DIRECTO"
  ],
  "SERVICE UNAVAILABLE": [
    "DIENST NICHT VERFÜGBAR",
    "SERVICE INDISPONIBLE",
    "SERVIZIO NON DISPONIBILE",
    "SERVICIO NO DISPONIBLE"
  ],
  "Connecting to the edition…": [
    "Verbindung zur Ausgabe…",
    "Connexion à l’édition…",
    "Connessione all’edizione…",
    "Conectando con la edición…"
  ],
  "Your session expired. Reconnect before signing in again.": [
    "Deine Sitzung ist abgelaufen. Stelle die Verbindung wieder her, bevor du dich erneut anmeldest.",
    "Ta session a expiré. Reconnecte le service avant de te reconnecter à ton compte.",
    "La sessione è scaduta. Riconnettiti al servizio prima di accedere di nuovo.",
    "Tu sesión ha caducado. Reconecta el servicio antes de volver a iniciar sesión."
  ],
  "Sign in to save your edition.": [
    "Melde dich an, um deine Ausgabe zu speichern.",
    "Connecte-toi pour enregistrer ton édition.",
    "Accedi per salvare la tua edizione.",
    "Inicia sesión para guardar tu edición."
  ],
  "Signed in as {username}.": [
    "Angemeldet als {username}.",
    "Connecté·e en tant que {username}.",
    "Accesso come {username}.",
    "Sesión iniciada como {username}."
  ],
  "You are browsing as a visitor.": [
    "Du bist als Gast unterwegs.",
    "Tu navigues en tant que visiteur.",
    "Stai navigando come ospite.",
    "Estás navegando como visitante."
  ],
  "Access to the newest matches is enabled.": [
    "Zugriff auf die neuesten Treffer ist aktiviert.",
    "L’accès aux résultats les plus récents est activé.",
    "L’accesso ai risultati più recenti è attivo.",
    "El acceso a los resultados más recientes está activado."
  ],
  "Access to the newest matches is limited for this account.": [
    "Der Zugriff auf die neuesten Treffer ist für dieses Konto eingeschränkt.",
    "L’accès aux résultats les plus récents est limité pour ce compte.",
    "L’accesso ai risultati più recenti è limitato per questo account.",
    "El acceso a los resultados más recientes está limitado para esta cuenta."
  ],
  "Sign in to access the newest matches and save searches.": [
    "Melde dich an, um die neuesten Treffer zu sehen und Suchen zu speichern.",
    "Connecte-toi pour voir les derniers résultats et enregistrer tes recherches.",
    "Accedi per vedere i risultati più recenti e salvare le ricerche.",
    "Inicia sesión para ver los resultados más recientes y guardar búsquedas."
  ],
  "Checking account access…": [
    "Kontozugriff wird geprüft…",
    "Vérification de l’accès au compte…",
    "Verifica dell’accesso all’account…",
    "Comprobando el acceso a la cuenta…"
  ],
  "Signing out…": [
    "Abmelden…",
    "Déconnexion…",
    "Disconnessione…",
    "Cerrando sesión…"
  ],
  "Deleting your account…": [
    "Dein Konto wird gelöscht…",
    "Suppression de ton compte…",
    "Eliminazione del tuo account…",
    "Eliminando tu cuenta…"
  ],
  "Account access is unavailable right now. Please try again later.": [
    "Der Kontozugriff ist gerade nicht verfügbar. Versuche es später erneut.",
    "L’accès au compte est indisponible pour le moment. Réessaie plus tard.",
    "L’accesso all’account non è disponibile al momento. Riprova più tardi.",
    "El acceso a la cuenta no está disponible ahora. Inténtalo más tarde."
  ],
  "Account access is unavailable while the privacy and usage notices are being reviewed.": [
    "Der Kontozugriff ist während der Prüfung der Datenschutz- und Nutzungshinweise nicht verfügbar.",
    "L’accès au compte est indisponible pendant la révision des avis de confidentialité et d’utilisation.",
    "L’accesso all’account non è disponibile durante la revisione delle informative sulla privacy e sull’utilizzo.",
    "El acceso a la cuenta no está disponible mientras se revisan los avisos de privacidad y uso."
  ],
  "Saved search": [
    "Gespeicherte Suche",
    "Recherche enregistrée",
    "Ricerca salvata",
    "Búsqueda guardada"
  ],
  "search": [
    "Suche",
    "recherche",
    "ricerca",
    "búsqueda"
  ],
  "Delete {title}": [
    "{title} löschen",
    "Supprimer {title}",
    "Elimina {title}",
    "Eliminar {title}"
  ],
  "Your search": [
    "Deine Suche",
    "Ta recherche",
    "La tua ricerca",
    "Tu búsqueda"
  ],
  "What work are you looking for?": [
    "Welche Arbeit suchst du?",
    "Quel travail recherches-tu ?",
    "Che lavoro stai cercando?",
    "¿Qué trabajo buscas?"
  ],
  "Search interpretation is unavailable right now. Your accepted searches remain available.": [
    "Die Suchauswertung ist gerade nicht verfügbar. Deine bestätigten Suchen bleiben verfügbar.",
    "L’interprétation des recherches est indisponible. Tes recherches validées restent accessibles.",
    "L’interpretazione della ricerca non è disponibile. Le ricerche confermate restano accessibili.",
    "La interpretación de búsquedas no está disponible. Tus búsquedas aceptadas siguen disponibles."
  ],
  "Some requirements cannot be applied.": [
    "Einige Anforderungen lassen sich nicht anwenden.",
    "Certains critères ne peuvent pas être appliqués.",
    "Alcuni requisiti non possono essere applicati.",
    "No se pueden aplicar algunos requisitos."
  ],
  "not supported": [
    "nicht unterstützt",
    "non pris en charge",
    "non supportato",
    "no compatible"
  ],
  "This saved search will be deleted from your account.": [
    "Diese gespeicherte Suche wird aus deinem Konto gelöscht.",
    "Cette recherche enregistrée sera supprimée de ton compte.",
    "Questa ricerca salvata verrà eliminata dal tuo account.",
    "Esta búsqueda guardada se eliminará de tu cuenta."
  ],
  "Sign in to interpret and save your search. Your unsent text stays here.": [
    "Melde dich an, um deine Suche auszuwerten und zu speichern. Dein ungesendeter Text bleibt hier.",
    "Connecte-toi pour interpréter et enregistrer ta recherche. Ton texte non envoyé reste ici.",
    "Accedi per interpretare e salvare la ricerca. Il testo non inviato resta qui.",
    "Inicia sesión para interpretar y guardar tu búsqueda. El texto sin enviar se queda aquí."
  ],
  "Imported listings need verification.": [
    "Importierte Stellen müssen überprüft werden.",
    "Les offres importées doivent être vérifiées.",
    "Le offerte importate richiedono verifica.",
    "Las ofertas importadas necesitan verificación."
  ],
  "Requirement checks failed. These positions are not included.": [
    "Die Anforderungsprüfung ist fehlgeschlagen. Diese Stellen sind nicht enthalten.",
    "La vérification des critères a échoué. Ces postes ne sont pas inclus.",
    "La verifica dei requisiti non è riuscita. Queste posizioni non sono incluse.",
    "La comprobación de requisitos ha fallado. Estas ofertas no se incluyen."
  ],
  "Search paused. There may be more matches.": [
    "Suche pausiert. Es könnte weitere Treffer geben.",
    "Recherche en pause. D’autres résultats sont possibles.",
    "Ricerca in pausa. Potrebbero esserci altri risultati.",
    "Búsqueda en pausa. Puede haber más resultados."
  ],
  "You’re through the available matches.": [
    "Du hast alle verfügbaren Treffer gesehen.",
    "Tu as vu tous les résultats disponibles.",
    "Hai visto tutti i risultati disponibili.",
    "Has visto todos los resultados disponibles."
  ],
  "No matching positions found in the completed search.": [
    "In der abgeschlossenen Suche wurden keine passenden Stellen gefunden.",
    "Aucun poste correspondant trouvé dans la recherche terminée.",
    "Nessuna posizione corrispondente trovata nella ricerca completata.",
    "No se encontraron ofertas coincidentes en la búsqueda completada."
  ],
  "More results are not available yet.": [
    "Weitere Ergebnisse sind noch nicht verfügbar.",
    "Aucun autre résultat disponible pour le moment.",
    "Altri risultati non sono ancora disponibili.",
    "Aún no hay más resultados disponibles."
  ],
  "Check the latest results without changing your search.": [
    "Prüfe die neuesten Ergebnisse, ohne deine Suche zu ändern.",
    "Consulte les derniers résultats sans modifier ta recherche.",
    "Controlla gli ultimi risultati senza modificare la ricerca.",
    "Consulta los últimos resultados sin cambiar tu búsqueda."
  ],
  "{count} recent match hidden": [
    "{count} neuer Treffer verborgen",
    "{count} résultat récent masqué",
    "{count} risultato recente nascosto",
    "{count} resultado reciente oculto"
  ],
  "{count} recent matches hidden": [
    "{count} neue Treffer verborgen",
    "{count} résultats récents masqués",
    "{count} risultati recenti nascosti",
    "{count} resultados recientes ocultos"
  ],
  "At least {count} recent match hidden": [
    "Mindestens {count} neuer Treffer verborgen",
    "Au moins {count} résultat récent masqué",
    "Almeno {count} risultato recente nascosto",
    "Al menos {count} resultado reciente oculto"
  ],
  "At least {count} recent matches hidden": [
    "Mindestens {count} neue Treffer verborgen",
    "Au moins {count} résultats récents masqués",
    "Almeno {count} risultati recenti nascosti",
    "Al menos {count} resultados recientes ocultos"
  ],
  "Your current account access does not include these matches.": [
    "Dein aktueller Kontozugriff umfasst diese Treffer nicht.",
    "Ton accès actuel n’inclut pas ces résultats.",
    "L’accesso attuale al tuo account non include questi risultati.",
    "El acceso actual a tu cuenta no incluye estos resultados."
  ],
  "Sign in to see the newest matches.": [
    "Melde dich an, um die neuesten Treffer zu sehen.",
    "Connecte-toi pour voir les derniers résultats.",
    "Accedi per vedere i risultati più recenti.",
    "Inicia sesión para ver los resultados más recientes."
  ],
  "Account access ↗": [
    "Kontozugriff ↗",
    "Accès au compte ↗",
    "Accesso all’account ↗",
    "Acceso a la cuenta ↗"
  ],
  "Sign in ↗": [
    "Anmelden ↗",
    "Se connecter ↗",
    "Accedi ↗",
    "Iniciar sesión ↗"
  ],
  "{count} positions still awaiting requirement checks.": [
    "{count} Stellen warten noch auf die Anforderungsprüfung.",
    "{count} postes attendent encore la vérification des critères.",
    "{count} posizioni attendono ancora la verifica dei requisiti.",
    "{count} ofertas siguen pendientes de comprobar requisitos."
  ],
  "{count} checks failed. These positions are not included.": [
    "{count} Prüfungen fehlgeschlagen. Diese Stellen sind nicht enthalten.",
    "{count} vérifications ont échoué. Ces postes ne sont pas inclus.",
    "{count} verifiche non riuscite. Queste posizioni non sono incluse.",
    "{count} comprobaciones fallidas. Estas ofertas no se incluyen."
  ],
  "{count} positions lack enough evidence to confirm a match.": [
    "Bei {count} Stellen fehlen Belege, um eine Übereinstimmung zu bestätigen.",
    "Pour {count} postes, les preuves ne suffisent pas à confirmer la correspondance.",
    "Per {count} posizioni mancano elementi sufficienti per confermare la corrispondenza.",
    "{count} ofertas no tienen pruebas suficientes para confirmar la coincidencia."
  ],
  "First observed {date}": [
    "Erstmals gesehen: {date}",
    "Repéré le {date}",
    "Rilevato il {date}",
    "Visto por primera vez el {date}"
  ],
  "The company catalogue is unavailable until the service reconnects.": [
    "Der Firmenkatalog ist bis zur Wiederverbindung nicht verfügbar.",
    "Le catalogue d’entreprises est indisponible jusqu’à la reconnexion du service.",
    "Il catalogo aziende non è disponibile finché il servizio non si riconnette.",
    "El catálogo de empresas no está disponible hasta que se reconecte el servicio."
  ],
  "Checking the directory…": [
    "Verzeichnis wird geprüft…",
    "Consultation du répertoire…",
    "Consultazione del catalogo…",
    "Consultando el catálogo…"
  ],
  "More from the directory…": [
    "Mehr aus dem Verzeichnis…",
    "La suite du répertoire…",
    "Altre aziende dal catalogo…",
    "Más del catálogo…"
  ],
  "That’s the directory so far.": [
    "Das ist das bisherige Verzeichnis.",
    "Voilà le répertoire pour le moment.",
    "Questo è il catalogo per ora.",
    "Eso es todo el catálogo por ahora."
  ],
  "No companies found.": [
    "Keine Firmen gefunden.",
    "Aucune entreprise trouvée.",
    "Nessuna azienda trovata.",
    "No se encontraron empresas."
  ],
  "No successful check reported.": [
    "Keine erfolgreiche Prüfung gemeldet.",
    "Aucune vérification réussie signalée.",
    "Nessuna verifica riuscita segnalata.",
    "No se ha registrado ninguna comprobación correcta."
  ],
  "Sources:": [
    "Quellen:",
    "Sources :",
    "Fonti:",
    "Fuentes:"
  ],
  "Sign in to request a company. Your lead stays here.": [
    "Melde dich an, um eine Firma vorzuschlagen. Dein Hinweis bleibt hier.",
    "Connecte-toi pour demander une entreprise. Ta piste reste ici.",
    "Accedi per richiedere un’azienda. La tua segnalazione resta qui.",
    "Inicia sesión para solicitar una empresa. Tu pista se queda aquí."
  ],
  "Which company did you mean?": [
    "Welche Firma meinst du?",
    "De quelle entreprise s’agit-il ?",
    "Quale azienda intendevi?",
    "¿A qué empresa te refieres?"
  ],
  "We couldn’t confidently identify this company. Try its website or full name.": [
    "Wir konnten diese Firma nicht eindeutig identifizieren. Versuche es mit ihrer Website oder dem vollständigen Namen.",
    "Nous n’avons pas pu identifier cette entreprise avec certitude. Essaie son site ou son nom complet.",
    "Non siamo riusciti a identificare l’azienda con certezza. Prova il sito o il nome completo.",
    "No pudimos identificar esta empresa con seguridad. Prueba con su web o nombre completo."
  ],
  "Your company request is recorded. Career-page collection is not confirmed.": [
    "Dein Firmenwunsch ist erfasst. Die Erfassung der Karriereseite ist nicht bestätigt.",
    "Ta demande est enregistrée. La collecte de la page carrière n’est pas confirmée.",
    "La tua richiesta è registrata. La raccolta della pagina carriere non è confermata.",
    "Tu solicitud está registrada. La recopilación de la página de empleo no está confirmada."
  ],
  "Imported snapshot": [
    "Importierter Datenstand",
    "Instantané importé",
    "Istantanea importata",
    "Instantánea importada"
  ],
  "Identity requested · collection not confirmed": [
    "Identität angefragt · Erfassung nicht bestätigt",
    "Identité demandée · collecte non confirmée",
    "Identità richiesta · raccolta non confermata",
    "Identidad solicitada · recopilación no confirmada"
  ],
  "Monitoring": [
    "Überwachung aktiv",
    "Suivi actif",
    "Monitoraggio attivo",
    "Seguimiento activo"
  ],
  "Coverage not reported": [
    "Abdeckung nicht gemeldet",
    "Couverture non indiquée",
    "Copertura non segnalata",
    "Cobertura no indicada"
  ],
  "Not reported": [
    "Nicht gemeldet",
    "Non indiqué",
    "Non segnalato",
    "No indicado"
  ],
  "Company coverage": [
    "Firmenabdeckung",
    "Couverture des entreprises",
    "Copertura aziende",
    "Cobertura de empresas"
  ],
  "verified {date}": [
    "geprüft am {date}",
    "vérifié le {date}",
    "verificato il {date}",
    "verificado el {date}"
  ],
  "refresh needed": [
    "Aktualisierung nötig",
    "actualisation nécessaire",
    "aggiornamento necessario",
    "actualización necesaria"
  ],
  "An imported snapshot does not imply continuous monitoring.": [
    "Ein importierter Datenstand bedeutet keine fortlaufende Überwachung.",
    "Un instantané importé n’implique pas un suivi continu.",
    "Un’istantanea importata non implica un monitoraggio continuo.",
    "Una instantánea importada no implica un seguimiento continuo."
  ],
  "See the company catalogue for reported sources and coverage.": [
    "Im Firmenkatalog findest du die gemeldeten Quellen und die Abdeckung.",
    "Consulte le catalogue des entreprises pour les sources et la couverture indiquées.",
    "Consulta il catalogo aziende per le fonti e la copertura segnalate.",
    "Consulta el catálogo de empresas para ver las fuentes y la cobertura indicadas."
  ],
  "This page could not load.": [
    "Diese Seite konnte nicht geladen werden.",
    "Cette page n’a pas pu se charger.",
    "Impossibile caricare questa pagina.",
    "No se pudo cargar esta página."
  ],
  "Your saved data remains with the service.": [
    "Deine gespeicherten Daten bleiben beim Dienst.",
    "Tes données enregistrées restent dans le service.",
    "I tuoi dati salvati restano nel servizio.",
    "Tus datos guardados permanecen en el servicio."
  ],
  "Reload Justup": [
    "Justup neu laden",
    "Recharger Justup",
    "Ricarica Justup",
    "Recargar Justup"
  ],
  "Up to {amount}": [
    "Bis {amount}",
    "Jusqu’à {amount}",
    "Fino a {amount}",
    "Hasta {amount}"
  ],
  "From {amount}": [
    "Ab {amount}",
    "À partir de {amount}",
    "Da {amount}",
    "Desde {amount}"
  ],
  "year": [
    "Jahr",
    "an",
    "anno",
    "año"
  ],
  "month": [
    "Monat",
    "mois",
    "mese",
    "mes"
  ],
  "week": [
    "Woche",
    "semaine",
    "settimana",
    "semana"
  ],
  "day": [
    "Tag",
    "jour",
    "giorno",
    "día"
  ],
  "hour": [
    "Stunde",
    "heure",
    "ora",
    "hora"
  ],
  "Remote": [
    "Remote",
    "À distance",
    "Da remoto",
    "En remoto"
  ],
  "Hybrid": [
    "Hybrid",
    "Hybride",
    "Ibrido",
    "Híbrido"
  ],
  "On site": [
    "Vor Ort",
    "Sur site",
    "In sede",
    "Presencial"
  ],
  "Full time": [
    "Vollzeit",
    "Temps plein",
    "Tempo pieno",
    "Jornada completa"
  ],
  "Part time": [
    "Teilzeit",
    "Temps partiel",
    "Tempo parziale",
    "Jornada parcial"
  ],
  "Contract": [
    "Vertrag",
    "Contrat",
    "Contratto",
    "Contrato"
  ],
  "Internship": [
    "Praktikum",
    "Stage",
    "Tirocinio",
    "Prácticas"
  ],
  "Temporary": [
    "Befristet",
    "Temporaire",
    "Temporaneo",
    "Temporal"
  ],
  "No sponsored listings.": [
    "Keine gesponserten Stellen.",
    "Aucune offre sponsorisée.",
    "Nessuna offerta sponsorizzata.",
    "Sin ofertas patrocinadas."
  ],
  "Employers can’t pay to move a job up. Matching results are always ordered newest first.": [
    "Arbeitgeber können nicht für eine höhere Platzierung zahlen. Passende Treffer sind immer nach Aktualität sortiert.",
    "Les employeurs ne peuvent pas payer pour remonter une offre. Les résultats sont toujours classés du plus récent au plus ancien.",
    "I datori di lavoro non possono pagare per salire in classifica. I risultati corrispondenti sono sempre ordinati dal più recente.",
    "Las empresas no pueden pagar para subir una oferta. Los resultados coincidentes se ordenan siempre del más reciente al más antiguo."
  ],
  "Last 14 days. Always.": [
    "Die letzten 14 Tage. Immer.",
    "Les 14 derniers jours. Toujours.",
    "Ultimi 14 giorni. Sempre.",
    "Últimos 14 días. Siempre."
  ],
  "Each job shows when we first found it. Only jobs first observed in the last 14 days appear.": [
    "Jede Stelle zeigt, wann wir sie erstmals gefunden haben. Nur Stellen aus den letzten 14 Tagen erscheinen.",
    "Chaque offre indique sa première détection. Seules celles repérées dans les 14 derniers jours apparaissent.",
    "Ogni offerta mostra quando l’abbiamo trovata. Appaiono solo quelle rilevate negli ultimi 14 giorni.",
    "Cada oferta muestra cuándo la encontramos. Solo aparecen las vistas por primera vez en los últimos 14 días."
  ],
  "See what’s included.": [
    "Sieh, was enthalten ist.",
    "Vois ce qui est inclus.",
    "Scopri cosa è incluso.",
    "Mira qué se incluye."
  ],
  "Browse the included companies and their original career-page links. Send us a lead for a company that’s missing.": [
    "Durchsuche die enthaltenen Firmen und ihre ursprünglichen Karriereseiten. Gib uns einen Hinweis, wenn eine Firma fehlt.",
    "Parcours les entreprises incluses et leurs pages carrière d’origine. Envoie-nous une piste pour une entreprise manquante.",
    "Esplora le aziende incluse e le loro pagine carriere originali. Segnalaci un’azienda che manca.",
    "Explora las empresas incluidas y sus páginas de empleo originales. Danos una pista sobre una empresa que falte."
  ],
  "The original source.": [
    "Die Originalquelle.",
    "La source d’origine.",
    "La fonte originale.",
    "La fuente original."
  ],
  "Each result links to its reported employer source. Read the full description and apply there.": [
    "Jeder Treffer verlinkt auf die gemeldete Arbeitgeberquelle. Lies die vollständige Beschreibung und bewirb dich dort.",
    "Chaque résultat renvoie à la source employeur indiquée. Lis la description complète et postule là-bas.",
    "Ogni risultato rimanda alla fonte del datore di lavoro indicata. Leggi la descrizione completa e candidati lì.",
    "Cada resultado enlaza a la fuente empresarial indicada. Lee la descripción completa y presenta tu candidatura allí."
  ]
} as const satisfies Record<string, readonly [string, string, string, string]>;
export type MessageKey = keyof typeof messages;
const languageIndex = { de: 0, fr: 1, it: 2, es: 3 } as const;
export function translate(locale: InterfaceLocale, key: MessageKey, params: Record<string, string | number> = {}): string {
  const template = locale === 'en' ? key : messages[key][languageIndex[locale]];
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (match, name: string) => params[name] === undefined ? match : String(params[name]));
}
// This helper is only for application-owned status and transport text, never job/model content.
export function translateNotice(locale: InterfaceLocale, text: string): string {
  if (Object.hasOwn(messages, text)) return translate(locale, text as MessageKey);
  const prefixes = ['Saved searches unavailable.', 'Saved workspace unavailable.', 'Viewed status is not synced yet.'] as const;
  for (const prefix of prefixes) if (text.startsWith(prefix + ' '))
    return `${translate(locale, prefix)} ${translateNotice(locale, text.slice(prefix.length + 1))}`;
  const suffixes = ['Your newer edits have not been applied.', 'The last accepted revision and its results are unchanged.', 'The last accepted search is unchanged.'] as const;
  for (const suffix of suffixes) if (text.endsWith(' ' + suffix))
    return `${translateNotice(locale, text.slice(0, -suffix.length - 1))} ${translate(locale, suffix)}`;
  const reference = text.match(/^(.*) Reference: ([^\n]+)\.$/u);
  if (reference) return `${translateNotice(locale, reference[1] ?? '')} ${translate(locale, 'Reference: {reference}.', { reference: reference[2] ?? '' })}`;
  const retry = text.match(/^(.*) Try again after (\d+) seconds\.$/u);
  if (retry) return `${translateNotice(locale, retry[1] ?? '')} ${translate(locale, 'Try again after {seconds} seconds.', { seconds: Number(retry[2]).toLocaleString(locale) })}`;
  return text;
}

export function translateCount(locale: InterfaceLocale, count: number, keys: {one: MessageKey; other: MessageKey}): string {
  const key = new Intl.PluralRules(locale).select(count) === 'one' ? keys.one : keys.other;
  return translate(locale, key, {count: new Intl.NumberFormat(locale).format(count)});
}
