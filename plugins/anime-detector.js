import axios from 'axios';
import fs from 'fs';
import path from 'path';

// Note: The 'iohook' import has been removed.

class AnimeCharacterBot {
    constructor() {
        this.animeAPIs = [
            'https://graphql.anilist.co/',
            'https://api.jikan.moe/v4/characters',
            'https://kitsu.io/api/edge/characters',
        ];
        this.tournamentMode = false;
        this.lastProcessedMessage = '';
        this.learnedCharacters = new Map();
        this.arabicCharacterNames = new Map();
        this.characterMappingsPath = path.join(process.cwd(), 'plugins', 'character-mappings.json');
        this.loadCharacterMappings();
        
        // Rate limiting and protection features
        this.messageQueue = [];
        this.isProcessing = false;
        this.lastMessageTime = 0;
        this.consecutiveFailures = 0;
        this.maxRetries = 3;
        this.baseDelay = 1000;
        this.maxDelay = 30000;
        
        // Anti-shutdown protection
        this.heartbeatInterval = null;
        this.startHeartbeat();
    }

    startHeartbeat() {
        // Prevent process from being killed by keeping it alive
        this.heartbeatInterval = setInterval(() => {
            // Keep the process alive with a minimal heartbeat
            if (process.uptime() > 0) {
                // Process is alive, continue
            }
        }, 30000); // Every 30 seconds
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    getExponentialBackoffDelay() {
        const delay = Math.min(this.baseDelay * Math.pow(2, this.consecutiveFailures), this.maxDelay);
        return delay + Math.random() * 1000; // Add jitter
    }

    async loadCharacterMappings() {
        try {
            if (fs.existsSync(this.characterMappingsPath)) {
                const data = fs.readFileSync(this.characterMappingsPath, 'utf8');
                const mappings = JSON.parse(data);
                if (mappings.arabicCharacterNames) {
                    this.arabicCharacterNames = new Map(Object.entries(mappings.arabicCharacterNames));
                }
                if (mappings.learnedCharacters) {
                    this.learnedCharacters = new Map(Object.entries(mappings.learnedCharacters));
                }
            } else {
                await this.saveCharacterMappings();
            }
        } catch (error) {
            this.arabicCharacterNames = new Map();
            this.learnedCharacters = new Map();
        }
    }

    async saveCharacterMappings() {
        try {
            const mappings = {
                arabicCharacterNames: Object.fromEntries(this.arabicCharacterNames),
                learnedCharacters: Object.fromEntries(this.learnedCharacters),
                lastUpdated: new Date().toISOString()
            };
            fs.writeFileSync(this.characterMappingsPath, JSON.stringify(mappings, null, 2), 'utf8');
        } catch (error) {
            // Silent error handling
        }
    }

    getAdaptiveDelay(characterCount = 1) {
        const baseDelay = 800;
        const perCharacterDelay = 300;
        const randomVariation = Math.floor(Math.random() * 1000);
        const calculatedDelay = baseDelay + ((characterCount - 1) * perCharacterDelay) + randomVariation;
        return calculatedDelay * 0.3;
    }

    async searchSingleAPI(apiUrl, characterName) {
        try {
            let searchUrl = '';
            if (apiUrl.includes('jikan.moe')) searchUrl = `${apiUrl}?q=${encodeURIComponent(characterName)}&limit=1`;
            else if (apiUrl.includes('kitsu.io')) searchUrl = `${apiUrl}?filter[name]=${encodeURIComponent(characterName)}&page[limit]=1`;
            else if (apiUrl.includes('anilist.co')) {
                const query = "query ($search: String) { Character(search: $search) { name { full native } id } }";
                const response = await axios.post(apiUrl, { query, variables: { search: characterName } }, { timeout: 660 });
                if (response.data?.data?.Character) {
                    const char = response.data.data.Character;
                    return { name: char.name.full || char.name.native, confidence: 0.9, source: 'AniList' };
                }
                return null;
            }
            const response = await axios.get(searchUrl, { timeout: 660, headers: { 'User-Agent': 'AnimeBot/1.0' } });
            if (response.data?.data?.[0]?.attributes) {
                const attrs = response.data.data[0].attributes;
                return { name: attrs.name || attrs.canonicalName, confidence: 0.8, source: apiUrl.split('/')[2] };
            }
        } catch (error) { /* Ignore API failures */ }
        return null;
    }

    isTournamentMessage(text) {
        const content = this.extractContentBetweenAsterisks(text);
        if (!content.trim()) return false;
        const tournamentWords = /تورنير|مسابقة|بطولة|مباراة|tournament|match|ضد|vs|versus|\/|\|/i.test(content);
        const hasMultipleWords = content.trim().split(/[\s\/\-\|،,؛;:vsضد]+/).length >= 2;
        return tournamentWords || hasMultipleWords;
    }

    async processMessage(message) {
        const messageText = message.body || '';
        if (!messageText.trim() || messageText === this.lastProcessedMessage) return null;
        
        // Check if message is recent (within 30 seconds)
        const now = Date.now();
        if (now - this.lastMessageTime < 30000) {
            // Message is too recent, skip processing
            return null;
        }
        
        const learnedCharacters = await this.extractPotentialCharacters(messageText);
        if (learnedCharacters.length === 0) return null;
        
        this.lastProcessedMessage = messageText;
        this.lastMessageTime = now;
        this.tournamentMode = this.isTournamentMessage(messageText);
        return { learnedCharacters, tournamentMode: this.tournamentMode, originalText: messageText };
    }

    sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    formatResponse(result) {
        if (!result || result.learnedCharacters.length === 0) return null;
        const characterNames = result.learnedCharacters.map(char => char.input);
        return { text: characterNames.join(' '), characterCount: characterNames.length };
    }

    normalizeArabicText(text) {
        return text.replace(/[أإآا]/g, 'ا').replace(/[ىي]/g, 'ي').replace(/[ةه]/g, 'ه').replace(/[ؤو]/g, 'و').replace(/[ئء]/g, 'ء').replace(/[كک]/g, 'ك').toLowerCase();
    }

    extractContentBetweenAsterisks(text) {
        const matches = text.match(/\*([^*]+)\*/g);
        return matches ? matches.map(m => m.slice(1, -1)).join(' ') : '';
    }

    // Enhanced emoji immunity with separator preservation
    cleanTextPreservingSeparators(text) {
        // Remove emojis but preserve separators
        const emojiRegex = /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu;
        return text.replace(emojiRegex, '').trim();
    }

    async extractPotentialCharacters(text) {
        const content = this.extractContentBetweenAsterisks(text);
        if (!content.trim()) return [];
        
        // Clean text while preserving separators
        const cleanedContent = this.cleanTextPreservingSeparators(content);
        if (!cleanedContent.trim()) return [];
        
        // Split by separators but preserve them for reconstruction
        const separators = /([\s\/\-\|،,؛;:]+)/g;
        const parts = cleanedContent.split(separators);
        
        const potentialCharacters = [];
        let currentIndex = 0;
        
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i].trim();
            if (!part) continue;
            
            // Check if this part is a separator
            if (separators.test(part)) {
                currentIndex++;
                continue;
            }
            
            // This is a potential character
            potentialCharacters.push({
                input: part,
                indices: [currentIndex],
                confidence: 1.0,
                isCharacter: true
            });
            currentIndex++;
        }
        
        if (potentialCharacters.length > 0) this.saveCharacterMappings().catch(() => {});
        return potentialCharacters;
    }

    isCommonWord(word) {
        const commonWords = [
            'في', 'من', 'الى', 'على', 'عن', 'كيف', 'متى', 'اين', 'ماذا', 'هذا', 'هذه', 'ذلك', 'تلك', 'التي', 'الذي',
            'عند', 'مع', 'حول', 'بين', 'خلف', 'امام', 'فوق', 'تحت', 'داخل', 'خارج', 'قبل', 'بعد', 'خلال', 'اثناء',
            'the', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'into', 'through', 'during',
            'هنا', 'هناك', 'حيث', 'متى', 'كيف', 'لماذا', 'اين', 'من', 'الى', 'على', 'في', 'مع', 'من', 'الى', 'على',
            'هذا', 'هذه', 'ذلك', 'تلك', 'التي', 'الذي', 'عند', 'مع', 'حول', 'بين', 'خلف', 'امام', 'فوق', 'تحت'
        ];
        return commonWords.includes(word.toLowerCase());
    }

    classifyWord(normalizedWord) {
        // Reject words with special characters, numbers, or symbols
        if (/[^ا-ي]/.test(normalizedWord) || /^[0-9]+$/.test(normalizedWord) || this.isCommonWord(normalizedWord)) {
            return { isCharacter: false, confidence: 0 };
        }
        
        // Reject single letters and very short words
        if (normalizedWord.length < 4 || normalizedWord.length > 10) {
            return { isCharacter: false, confidence: 0 };
        }
        
        // Reject common Arabic words that are definitely not anime characters
        const nonAnimeWords = [
            'اسم', 'هذا', 'هذه', 'ذلك', 'تلك', 'التي', 'الذي', 'عند', 'مع', 'في', 'من', 'الى', 'على', 
            'كيف', 'متى', 'اين', 'ماذا', 'هنا', 'هناك', 'حيث', 'لماذا', 'كذا', 'كذلك', 'ايضا', 'ايضا',
            'س', 'ص', 'ض', 'ط', 'ظ', 'ع', 'غ', 'ف', 'ق', 'ك', 'ل', 'م', 'ن', 'ه', 'و', 'ي'
        ];
        
        if (nonAnimeWords.includes(normalizedWord)) {
            return { isCharacter: false, confidence: 0 };
        }
        
        // More strict anime character patterns
        let score = 0;
        
        // Common anime character name endings (Japanese-style names)
        if (/كو$|كي$|تو$|رو$|مي$|ري$|سا|نا|يو|شي|كو$|كي$|تو$|رو$|مي$|ري$/.test(normalizedWord)) score += 0.7;
        
        // Common anime character name patterns (pure Arabic letters only)
        if (/^[ا-ي]{4,8}$/.test(normalizedWord)) score += 0.5;
        
        // Specific anime character name endings
        if (/ه$|ة$|ي$|و$|ا$/.test(normalizedWord)) score += 0.6;
        
        // Length check for typical anime names
        if (normalizedWord.length >= 4 && normalizedWord.length <= 8) score += 0.5;
        
        // Consonant-vowel ratio typical of anime names
        const consonantRatio = (normalizedWord.length - (normalizedWord.match(/[اوي]/g) || []).length) / normalizedWord.length;
        if (consonantRatio >= 0.4 && consonantRatio <= 0.7) score += 0.4;
        
        // Penalize repetitive characters
        if (/([ا-ي])\1\1/.test(normalizedWord)) score -= 0.5;
        
        // Penalize common non-anime words
        if (/هذا|هذه|ذلك|تلك|التي|الذي|عند|مع|في|من|الى|على|كيف|متى|اين|ماذا|اسم/.test(normalizedWord)) score -= 0.8;
        
        // Bonus for known anime character patterns
        if (/^[ا-ي]{4,6}$/.test(normalizedWord) && !this.isCommonWord(normalizedWord)) score += 0.3;
        
        const finalScore = Math.max(0, Math.min(score, 1.0));
        return { isCharacter: finalScore > 0.6, confidence: finalScore };
    }

    async searchCharacterInDatabases(characterName) {
        const normalizedName = this.normalizeArabicText(characterName);
        if (this.arabicCharacterNames.has(normalizedName)) return { name: this.arabicCharacterNames.get(normalizedName), confidence: 1.0, source: 'Local Mapping' };
        if (this.learnedCharacters.has(normalizedName)) return { ...this.learnedCharacters.get(normalizedName), source: 'Learned Characters' };
        const apiPromises = this.animeAPIs.map(api => this.searchSingleAPI(api, characterName));
        const results = await Promise.all(apiPromises);
        const validResults = results.filter(Boolean);
        if (validResults.length > 0) return validResults.reduce((best, current) => current.confidence > best.confidence ? current : best);
        return null;
    }
}

// WhatsApp Bot Integration for Baileys
class WhatsAppAnimeBot {
    constructor(sock) {
        this.sock = sock;
        this.animeBot = new AnimeCharacterBot();
        this.isActive = false; // Bot starts as inactive by default
        this.selectedGroup = null; // Selected group to work in
        this.activationTimestamp = 0; // Timestamp when the bot was activated in a group
        this.ownerNumbers = ['96176337375','966584646464','967771654273','967739279014']; // Add owner phone numbers here
        this.messageHandler = null;
        this.processedMessages = new Set();
        this.lastMessageTime = 0;
        this.messageQueue = [];
        this.isProcessingQueue = false;
        this.setupMessageHandler();
    }

    isOwner(senderNumber) {
        // Remove @s.whatsapp.net suffix if present
        const cleanNumber = senderNumber.replace('@s.whatsapp.net', '');
        const isOwner = this.ownerNumbers.includes(cleanNumber);
        return isOwner;
    }

    async getGroupsList() {
        try {
            const groups = await this.sock.groupFetchAllParticipating();
            return Object.entries(groups).map(([id, group]) => ({
                id: id,
                name: group.subject || 'Unknown Group',
                participants: group.participants?.length || 0
            }));
        } catch (error) {
            return [];
        }
    }

    async processMessageQueue() {
        if (this.isProcessingQueue || this.messageQueue.length === 0) return;
        
        this.isProcessingQueue = true;
        
        while (this.messageQueue.length > 0) {
            const messageData = this.messageQueue.shift();
            
            try {
                const result = await this.animeBot.processMessage({ body: messageData.text });
                if (result?.learnedCharacters?.length > 0) {
                    const responseData = this.animeBot.formatResponse(result);
                    if (responseData?.text) {
                        // Apply exponential backoff for rate limiting
                        const delay = this.animeBot.getExponentialBackoffDelay();
                        await this.animeBot.sleep(delay);
                        
                        await this.sock.sendMessage(messageData.chatId, { text: responseData.text });
                        this.animeBot.consecutiveFailures = 0; // Reset on success
                    }
                }
            } catch (error) {
                this.animeBot.consecutiveFailures++;
                const backoffDelay = this.animeBot.getExponentialBackoffDelay();
                await this.animeBot.sleep(backoffDelay);
            }
        }
        
        this.isProcessingQueue = false;
    }

    setupMessageHandler() {
        if (this.messageHandler) this.sock.ev.off('messages.upsert', this.messageHandler);
        
        this.messageHandler = async (messageUpdate) => {
            for (const message of messageUpdate.messages) {
                const msgContent = message.message?.conversation || message.message?.extendedTextMessage?.text;
                
                if (message.key.fromMe || !msgContent) {
                    continue;
                }
                
                const messageId = `${message.key.remoteJid}-${message.key.id}-${message.messageTimestamp}`;
                if (this.processedMessages.has(messageId)) continue;
                
                this.processedMessages.add(messageId);
                if (this.processedMessages.size > 200) {
                    this.processedMessages.delete(this.processedMessages.values().next().value);
                }
                
                const chatId = message.key.remoteJid;
                
                try {
                    // Get sender number for owner check
                    const senderNumber = message.key.participant || message.key.remoteJid?.split('@')[0];
                    
                    // --- Owner-only Control Logic ---
                    if (msgContent.trim() === '.a' || msgContent.trim() === '.ابدا') {
                        if (!this.isOwner(senderNumber)) {
                            continue; // Silent ignore - no response
                        }
                        
                        // Show groups list for selection
                        const groups = await this.getGroupsList();
                        if (groups.length === 0) {
                            await this.sock.sendMessage(chatId, { text: '❌ No groups found!' });
                            continue;
                        }
                        
                        let groupsList = '📋 **Available Groups:**\n';
                        groups.forEach((group, index) => {
                            groupsList += `${index + 1}. ${group.name} (${group.participants} members)\n`;
                        });
                        groupsList += '\nReply with the group number to activate the bot in that group.';
                        
                        await this.sock.sendMessage(chatId, { text: groupsList });
                        continue;
                    }
                    
                    if (msgContent.trim() === '.x' || msgContent.trim() === '.وقف') {
                        if (!this.isOwner(senderNumber)) {
                            continue; // Silent ignore - no response
                        }
                        
                        this.isActive = false;
                        this.selectedGroup = null;
                        await this.sock.sendMessage(chatId, { text: '🔴 Bot deactivated successfully!' });
                        continue;
                    }
                    
                    // Group selection logic
                    if (this.isOwner(senderNumber) && /^\d+$/.test(msgContent.trim()) && !this.isActive) {
                        const groups = await this.getGroupsList();
                        const selectedIndex = parseInt(msgContent.trim()) - 1;
                        
                        if (selectedIndex >= 0 && selectedIndex < groups.length) {
                            this.selectedGroup = groups[selectedIndex].id;
                            this.isActive = true;
                            this.activationTimestamp = message.messageTimestamp; // Set activation timestamp to the message's timestamp (in seconds)
                            await this.sock.sendMessage(chatId, {
                                text: `✅ Bot activated in: **${groups[selectedIndex].name}**\n\nNow the bot will only respond in this group.`
                            });
                        } else {
                            await this.sock.sendMessage(chatId, { text: '❌ Invalid group number!' });
                        }
                        continue;
                    }
                    
                    // Status check command
                    if (msgContent.trim() === '.status' || msgContent.trim() === '.حالة') {
                        const status = this.getStatus();
                        await this.sock.sendMessage(chatId, { text: `🤖 Bot Status: ${status.status}` });
                        continue;
                    }
                    
                    // The character detection logic ONLY runs if the bot is active and in the selected group
                    if (this.isActive && this.selectedGroup && chatId === this.selectedGroup && message.messageTimestamp >= this.activationTimestamp) {
                        // Ultra clean logging - only show actual messages
                        console.log(`${message.pushName || chatId.split('@')[0]}: ${msgContent}`);
                        
                        // Add to message queue for processing with rate limiting
                        this.messageQueue.push({
                            text: msgContent,
                            chatId: chatId,
                            timestamp: Date.now()
                        });
                        
                        // Process queue if not already processing
                        if (!this.isProcessingQueue) {
                            this.processMessageQueue();
                        }
                    }
                } catch (error) {
                    // Silent error handling
                }
            }
        };
        
        this.sock.ev.on('messages.upsert', this.messageHandler);
    }

    cleanup() {
        if (this.messageHandler) this.sock.ev.off('messages.upsert', this.messageHandler);
        this.animeBot.stopHeartbeat();
    }

    getStatus() {
        const groupInfo = this.selectedGroup ? ` in selected group` : '';
        return {
            active: this.isActive,
            selectedGroup: this.selectedGroup,
            charactersLearned: this.animeBot.learnedCharacters.size,
            status: this.isActive ? `Active${groupInfo} - Detecting anime characters` : 'Inactive - Send .ابدا to activate'
        };
    }
}

export { AnimeCharacterBot, WhatsAppAnimeBot };