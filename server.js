const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Créer le dossier data s'il n'existe pas
if (!fs.existsSync('./data')) {
    fs.mkdirSync('./data');
}

// ==================== BASE DE DONNÉES ====================
const db = new sqlite3.Database('./data/users.db');

// Création des tables
db.serialize(() => {
    // Table utilisateurs
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            xp INTEGER DEFAULT 0,
            level INTEGER DEFAULT 1,
            total_commands INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // Table commandes utilisées
    db.run(`
        CREATE TABLE IF NOT EXISTS commands (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            command TEXT,
            executed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )
    `);
    
    // Table pour les succès (achievements)
    db.run(`
        CREATE TABLE IF NOT EXISTS achievements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            achievement_name TEXT,
            unlocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )
    `);
    
    console.log('✅ Base de données initialisée avec succès');
});

// ==================== ROUTES API ====================

// 1. INSCRIPTION
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Username et password requis' });
    }
    
    if (password.length < 4) {
        return res.status(400).json({ error: 'Le mot de passe doit faire au moins 4 caractères' });
    }
    
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        
        db.run(
            'INSERT INTO users (username, password) VALUES (?, ?)',
            [username, hashedPassword],
            function(err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) {
                        return res.status(400).json({ error: 'Ce pseudo existe déjà' });
                    }
                    return res.status(500).json({ error: err.message });
                }
                res.json({ 
                    success: true, 
                    userId: this.lastID,
                    username: username,
                    message: '✅ Inscription réussie ! Bienvenue sur JN-Sec' 
                });
            }
        );
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. CONNEXION
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    db.get(
        'SELECT * FROM users WHERE username = ?',
        [username],
        async (err, user) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!user) return res.status(401).json({ error: '❌ Utilisateur non trouvé' });
            
            const validPassword = await bcrypt.compare(password, user.password);
            if (!validPassword) return res.status(401).json({ error: '❌ Mot de passe incorrect' });
            
            res.json({
                success: true,
                user: {
                    id: user.id,
                    username: user.username,
                    xp: user.xp,
                    level: user.level,
                    total_commands: user.total_commands
                }
            });
        }
    );
});

// 3. SAUVEGARDER UNE COMMANDE + AJOUTER XP
app.post('/api/command', (req, res) => {
    const { userId, command } = req.body;
    
    if (!userId || !command) {
        return res.status(400).json({ error: 'userId et command requis' });
    }
    
    // Ajouter la commande à l'historique
    db.run(
        'INSERT INTO commands (user_id, command) VALUES (?, ?)',
        [userId, command]
    );
    
    // Ajouter 10 XP pour chaque commande
    db.get('SELECT xp, level, total_commands FROM users WHERE id = ?', [userId], (err, user) => {
        if (err || !user) return res.status(500).json({ error: 'Utilisateur non trouvé' });
        
        let newXp = user.xp + 10;
        let newLevel = user.level;
        let leveledUp = false;
        
        // Niveau suivant tous les 100 XP
        if (newXp >= newLevel * 100) {
            newLevel++;
            newXp = 0;
            leveledUp = true;
            
            // Enregistrer le succès de niveau
            db.run(
                'INSERT INTO achievements (user_id, achievement_name) VALUES (?, ?)',
                [userId, `LEVEL_${newLevel}`]
            );
        }
        
        const newTotalCommands = (user.total_commands || 0) + 1;
        
        db.run(
            'UPDATE users SET xp = ?, level = ?, total_commands = ? WHERE id = ?',
            [newXp, newLevel, newTotalCommands, userId],
            (err) => {
                if (err) return res.status(500).json({ error: err.message });
                
                res.json({
                    success: true,
                    xp: newXp,
                    level: newLevel,
                    total_commands: newTotalCommands,
                    leveledUp: leveledUp
                });
            }
        );
    });
});

// 4. RÉCUPÉRER LE LEADERBOARD
app.get('/api/leaderboard', (req, res) => {
    db.all(
        `SELECT username, level, xp, total_commands 
         FROM users 
         ORDER BY level DESC, xp DESC, total_commands DESC 
         LIMIT 10`,
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

// 5. RÉCUPÉRER L'HISTORIQUE DES COMMANDES D'UN USER
app.get('/api/history/:userId', (req, res) => {
    const { userId } = req.params;
    
    db.all(
        `SELECT command, executed_at 
         FROM commands 
         WHERE user_id = ? 
         ORDER BY executed_at DESC 
         LIMIT 20`,
        [userId],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

// 6. RÉCUPÉRER LES SUCCÈS D'UN USER
app.get('/api/achievements/:userId', (req, res) => {
    const { userId } = req.params;
    
    db.all(
        `SELECT achievement_name, unlocked_at 
         FROM achievements 
         WHERE user_id = ? 
         ORDER BY unlocked_at DESC`,
        [userId],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

// 7. RÉCUPÉRER LES STATS GLOBALES
app.get('/api/stats', (req, res) => {
    db.get(`SELECT COUNT(*) as total_users FROM users`, [], (err, users) => {
        db.get(`SELECT COUNT(*) as total_commands FROM commands`, [], (err, commands) => {
            db.get(`SELECT AVG(level) as avg_level FROM users`, [], (err, avgLevel) => {
                res.json({
                    total_users: users?.total_users || 0,
                    total_commands: commands?.total_commands || 0,
                    avg_level: Math.round(avgLevel?.avg_level || 0)
                });
            });
        });
    });
});

// Démarrer le serveur
app.listen(PORT, () => {
    console.log(`
    ╔══════════════════════════════════════════════════════╗
    ║                                                      ║
    ║     🚀 JATHNIEL SECURITY PLATFORM - SERVEUR ACTIF   ║
    ║                                                      ║
    ║     📡 http://localhost:${PORT}                          ║
    ║     💾 Base de données : SQLite (data/users.db)     ║
    ║     👑 Créé par Jathniel                            ║
    ║                                                      ║
    ╚══════════════════════════════════════════════════════╝
    `);
});