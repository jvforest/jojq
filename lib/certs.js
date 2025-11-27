#!/usr/bin/env node

const forge = require('node-forge');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { getColor } = require('./config');

// ============= CERTIFICATE MANAGER =============
class CertificateManager {
  constructor() {
    this.certDir = path.join(os.homedir(), '.jojq', 'certs');
    this.caKeyPath = path.join(this.certDir, 'ca-key.pem');
    this.caCertPath = path.join(this.certDir, 'ca-cert.pem');
    this.cache = new Map(); // Cache generated certs
  }

  ensureCertDir() {
    if (!fs.existsSync(this.certDir)) {
      fs.mkdirSync(this.certDir, { recursive: true });
    }
  }

  async promptForCertLocation() {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      const defaultPath = this.certDir;
      const desktopPath = path.join(os.homedir(), 'Desktop', 'jojq-certs');
      
      console.log(getColor('prompt')('\n📍 Where would you like to save the CA certificate?\n'));
      console.log(getColor('info')(`  1. Default location (hidden): ${defaultPath}`));
      console.log(getColor('info')(`  2. Desktop (easy access):     ${desktopPath}\n`));
      
      rl.question(getColor('prompt')('Choose [1] or [2] (default: 1): '), (answer) => {
        rl.close();
        
        const choice = answer.trim();
        if (choice === '2') {
          resolve(desktopPath);
        } else {
          resolve(defaultPath);
        }
      });
    });
  }

  async loadOrGenerateCA() {
    this.ensureCertDir();

    // Try to load existing CA
    if (fs.existsSync(this.caKeyPath) && fs.existsSync(this.caCertPath)) {
      try {
        const caKeyPem = fs.readFileSync(this.caKeyPath, 'utf8');
        const caCertPem = fs.readFileSync(this.caCertPath, 'utf8');
        
        this.caKey = forge.pki.privateKeyFromPem(caKeyPem);
        this.caCert = forge.pki.certificateFromPem(caCertPem);
        
        console.log(getColor('success')('✓ Loaded existing CA certificate'));
        console.log(getColor('info')(`  Location: ${this.caCertPath}`));
        return;
      } catch (err) {
        console.log(getColor('warning')('⚠️  Failed to load CA, generating new one...'));
      }
    }

    // Ask user where to save the certificate
    const chosenPath = await this.promptForCertLocation();
    
    // Update paths based on choice
    this.certDir = chosenPath;
    this.caKeyPath = path.join(this.certDir, 'ca-key.pem');
    this.caCertPath = path.join(this.certDir, 'ca-cert.pem');
    
    // Ensure the chosen directory exists
    if (!fs.existsSync(this.certDir)) {
      fs.mkdirSync(this.certDir, { recursive: true });
    }

    // Generate new CA
    console.log(getColor('info')('\n📜 Generating new CA certificate (this may take a moment)...'));
    
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
    
    const attrs = [{
      name: 'commonName',
      value: 'jojq Root CA'
    }, {
      name: 'countryName',
      value: 'US'
    }, {
      shortName: 'ST',
      value: 'Development'
    }, {
      name: 'localityName',
      value: 'Local'
    }, {
      name: 'organizationName',
      value: 'jojq Development'
    }, {
      shortName: 'OU',
      value: 'jojq Proxy'
    }];
    
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([{
      name: 'basicConstraints',
      cA: true
    }, {
      name: 'keyUsage',
      keyCertSign: true,
      digitalSignature: true,
      nonRepudiation: true,
      keyEncipherment: true,
      dataEncipherment: true
    }, {
      name: 'extKeyUsage',
      serverAuth: true,
      clientAuth: true,
      codeSigning: true,
      emailProtection: true,
      timeStamping: true
    }]);
    
    cert.sign(keys.privateKey, forge.md.sha256.create());
    
    // Save CA certificate and key
    const caKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
    const caCertPem = forge.pki.certificateToPem(cert);
    
    fs.writeFileSync(this.caKeyPath, caKeyPem);
    fs.writeFileSync(this.caCertPath, caCertPem);
    
    this.caKey = keys.privateKey;
    this.caCert = cert;
    
    console.log(getColor('success')('\n✓ CA certificate generated successfully!'));
    console.log(getColor('info')(`  Certificate: ${this.caCertPath}`));
    console.log(getColor('info')(`  Private Key: ${this.caKeyPath}`));
    
    if (this.certDir.includes('Desktop')) {
      console.log(getColor('prompt')('\n💡 Certificate saved to Desktop for easy access!'));
      console.log(getColor('info')('   You can now easily find and install it in Postman.\n'));
    } else {
      console.log(getColor('dim')('\n   (Hidden location - certificate will persist across sessions)\n'));
    }
  }

  generateCertForHost(hostname) {
    // Check cache first
    if (this.cache.has(hostname)) {
      return this.cache.get(hostname);
    }

    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    
    cert.publicKey = keys.publicKey;
    cert.serialNumber = Date.now().toString();
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
    
    cert.setSubject([{
      name: 'commonName',
      value: hostname
    }]);
    
    cert.setIssuer(this.caCert.subject.attributes);
    
    cert.setExtensions([{
      name: 'basicConstraints',
      cA: false
    }, {
      name: 'keyUsage',
      keyCertSign: false,
      digitalSignature: true,
      nonRepudiation: false,
      keyEncipherment: true,
      dataEncipherment: true
    }, {
      name: 'extKeyUsage',
      serverAuth: true,
      clientAuth: true
    }, {
      name: 'subjectAltName',
      altNames: [{
        type: 2, // DNS
        value: hostname
      }]
    }]);
    
    cert.sign(this.caKey, forge.md.sha256.create());
    
    const result = {
      key: forge.pki.privateKeyToPem(keys.privateKey),
      cert: forge.pki.certificateToPem(cert)
    };
    
    // Cache it
    this.cache.set(hostname, result);
    
    return result;
  }

  getCACertPath() {
    return this.caCertPath;
  }
}

module.exports = { CertificateManager };

