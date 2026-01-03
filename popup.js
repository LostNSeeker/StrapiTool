// Global variables
let extractedMetadata = null;
let extractedFAQs = []; // Array of {question, answer} objects
let extractedDisclaimer = '';

// DOM Elements
const docxFileInput = document.getElementById('docxFile');
const fileNameDisplay = document.getElementById('fileName');
const previewSection = document.getElementById('previewSection');
const metadataPreview = document.getElementById('metadataPreview');
const statusDiv = document.getElementById('status');
const loadingDiv = document.getElementById('loading');
const saveConfigBtn = document.getElementById('saveConfig');
const testConnectionBtn = document.getElementById('testConnection');

// Configuration inputs
const strapiUrlInput = document.getElementById('strapiUrl');
const apiTokenInput = document.getElementById('apiToken');
const collectionTypeInput = document.getElementById('collectionType');

// Function to get current collection type
function getCollectionType() {
  return collectionTypeInput ? collectionTypeInput.value : 'ck-blog';
}

// Utility functions
function showStatus(message, type) {
  statusDiv.textContent = message;
  statusDiv.className = `status ${type}`;
  statusDiv.classList.remove('hidden');
  
  if (type === 'success') {
    setTimeout(() => {
      statusDiv.classList.add('hidden');
    }, 5000);
  }
}

function showLoading(show) {
  if (show) {
    loadingDiv.classList.remove('hidden');
  } else {
    loadingDiv.classList.add('hidden');
  }
}

function resetForm() {
  docxFileInput.value = '';
  fileNameDisplay.textContent = '';
  previewSection.classList.add('hidden');
  extractedMetadata = null;
  extractedFAQs = [];
  extractedDisclaimer = '';
  metadataPreview.innerHTML = '';
}

// Load saved configuration
chrome.storage.local.get(['strapiUrl', 'apiToken', 'collectionType'], (result) => {
  if (result.strapiUrl) strapiUrlInput.value = result.strapiUrl;
  if (result.apiToken) apiTokenInput.value = result.apiToken;
  if (result.collectionType && collectionTypeInput) {
    collectionTypeInput.value = result.collectionType;
  }
});

// Save configuration
saveConfigBtn.addEventListener('click', () => {
  const config = {
    strapiUrl: strapiUrlInput.value.trim(),
    apiToken: apiTokenInput.value.trim(),
    collectionType: collectionTypeInput ? collectionTypeInput.value : 'ck-blog'
  };
  
  if (!config.strapiUrl || !config.apiToken) {
    showStatus('Please fill in Strapi URL and API Token', 'error');
    return;
  }
  
  chrome.storage.local.set(config, () => {
    showStatus('Configuration saved successfully!', 'success');
  });
});

// Test connection and permissions
testConnectionBtn.addEventListener('click', async () => {
  showLoading(true);
  
  const config = {
    strapiUrl: strapiUrlInput.value.trim(),
    apiToken: apiTokenInput.value.trim()
  };
  
  if (!config.strapiUrl || !config.apiToken) {
    showLoading(false);
    showStatus('Please fill in all configuration fields first', 'error');
    return;
  }
  
  try {
    const collectionType = getCollectionType();
    const endpoints = [
      `${config.strapiUrl}/api/${collectionType}s`,
      `${config.strapiUrl}/api/${collectionType}`
    ];
    
    let success = false;
    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${config.apiToken}`
          }
        });
        
        if (response.status !== 404) {
          success = true;
          if (response.ok) {
            showStatus('Connection successful! Content type found and accessible.', 'success');
          } else if (response.status === 401 || response.status === 403) {
            showStatus('Connection failed: Invalid API token or insufficient permissions. Check your API token settings in Strapi.', 'error');
          } else {
            showStatus(`Connection established but got status ${response.status}. Check permissions.`, 'error');
          }
          break;
        }
      } catch (error) {
        console.log(`Error testing ${endpoint}:`, error);
      }
    }
    
    if (!success) {
      showStatus('Connection failed: Content type not found. Ensure the ck-blog content type exists in Strapi.', 'error');
    }
  } catch (error) {
    showStatus(`Connection error: ${error.message}`, 'error');
  }
  
  showLoading(false);
});

// File input change handler
docxFileInput.addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  
  if (!file.name.toLowerCase().endsWith('.docx')) {
    showStatus('Please select a .docx file', 'error');
    return;
  }
  
  fileNameDisplay.textContent = file.name;
  await parseDocxFile(file);
});

// Parse DOCX file
async function parseDocxFile(file) {
  console.log('Starting to parse DOCX file:', file.name);
  showLoading(true);
  
  try {
    const arrayBuffer = await file.arrayBuffer();
    
    // Extract form fields from DOCX
    try {
      extractedMetadata = await extractFormFieldsFromDocx(arrayBuffer);
      console.log('Extracted form fields from DOCX:', extractedMetadata);
    } catch (error) {
      console.log('Could not extract form fields, will try HTML parsing:', error);
      extractedMetadata = {
        title: '',
        metaTitle: '',
        metaDescription: '',
        metaKeywords: '',
        canonicalUrl: ''
      };
    }
    
    // Parse with mammoth to HTML
    const result = await mammoth.convertToHtml({ arrayBuffer: arrayBuffer });
    let htmlContent = result.value;
    console.log('DOCX converted to HTML, length:', htmlContent.length);
    
    // Extract metadata from HTML
    const htmlMetadata = extractMetadataFromContent(htmlContent);
    console.log('Extracted metadata from HTML:', htmlMetadata);
    
    // Merge metadata
    if (!extractedMetadata) {
      extractedMetadata = {};
    }
    extractedMetadata = {
      title: extractedMetadata.title || htmlMetadata.title || '',
      metaTitle: extractedMetadata.metaTitle || htmlMetadata.metaTitle || '',
      metaDescription: extractedMetadata.metaDescription || htmlMetadata.metaDescription || '',
      metaKeywords: extractedMetadata.metaKeywords || htmlMetadata.metaKeywords || '',
      canonicalUrl: extractedMetadata.canonicalUrl || htmlMetadata.canonicalUrl || ''
    };
    
    // Extract FAQs and Disclaimer
    extractFAQsAndDisclaimer(htmlContent);
    
    // Fallback title from filename if not found
    if (!extractedMetadata.title || extractedMetadata.title.trim() === '') {
      const fileNameWithoutExt = file.name.replace(/\.docx?$/i, '').trim();
      if (fileNameWithoutExt) {
        extractedMetadata.title = fileNameWithoutExt;
      } else {
        extractedMetadata.title = 'Untitled Post';
      }
    }
    
    console.log('Final extracted metadata:', extractedMetadata);
    
    // Show preview
    displayMetadataPreview();
    previewSection.classList.remove('hidden');
    
    // Auto-create draft in Strapi
    await createDraftInStrapi();
    
  } catch (error) {
    console.error('Error parsing DOCX:', error);
    showStatus(`Error parsing file: ${error.message}`, 'error');
    showLoading(false);
  }
}

// Extract form fields from DOCX
async function extractFormFieldsFromDocx(arrayBuffer) {
  console.log('Extracting form fields from DOCX XML...');
  const metadata = {
    title: '',
    metaTitle: '',
    metaDescription: '',
    metaKeywords: '',
    canonicalUrl: ''
  };
  
  try {
    const result = await mammoth.extractRawText({ arrayBuffer: arrayBuffer });
    const rawText = result.value;
    
    const htmlResult = await mammoth.convertToHtml({ arrayBuffer: arrayBuffer });
    const htmlContent = htmlResult.value;
    
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = htmlContent;
    const paragraphs = tempDiv.querySelectorAll('p');
    
    // Check first 50 paragraphs for metadata patterns
    for (let i = 0; i < Math.min(50, paragraphs.length); i++) {
      const text = paragraphs[i].textContent.trim();
      
      const patterns = [
        { pattern: /^(url|URL)\s*[:\-=\|]\s*(.+)$/i, key: 'canonicalUrl' },
        { pattern: /^(meta-title|Meta-Title|metatitle|metaTitle|meta title|Meta Title)\s*[:\-=\|]\s*(.+)$/i, key: 'metaTitle' },
        { pattern: /^(meta-description|Meta-Description|metadescription|metaDescription|meta description|Meta Description)\s*[:\-=\|]\s*(.+)$/i, key: 'metaDescription' },
        { pattern: /^(meta-keywords|Meta-Keywords|metakeywords|metaKeywords|meta keywords|Meta Keywords)\s*[:\-=\|]\s*(.+)$/i, key: 'metaKeywords' },
        { pattern: /^(canonicalurl|canonicalUrl|canonical url|Canonical URL)\s*[:\-=\|]\s*(.+)$/i, key: 'canonicalUrl' },
        { pattern: /^(title|Title)\s*[:\-=\|]\s*(.+)$/i, key: 'title' }
      ];
      
      for (const { pattern, key } of patterns) {
        const match = text.match(pattern);
        if (match && !metadata[key]) {
          metadata[key] = match[2].trim();
          console.log(`Found ${key} (form field):`, metadata[key]);
          break;
        }
      }
    }
    
    // Also check raw text lines
    const lines = rawText.split('\n');
    for (let i = 0; i < Math.min(100, lines.length); i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      for (const { pattern, key } of patterns) {
        const match = line.match(pattern);
        if (match && !metadata[key]) {
          metadata[key] = match[2].trim();
          console.log(`Found ${key} (raw text):`, metadata[key]);
          break;
        }
      }
    }
    
  } catch (error) {
    console.error('Error extracting form fields from DOCX:', error);
  }
  
  return metadata;
}

// Extract metadata from HTML content
function extractMetadataFromContent(html) {
  console.log('Starting metadata extraction from HTML...');
  const metadata = {
    title: '',
    metaTitle: '',
    metaDescription: '',
    metaKeywords: '',
    canonicalUrl: ''
  };
  
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = html;
  
  const paragraphs = tempDiv.querySelectorAll('p');
  const headings = tempDiv.querySelectorAll('h1, h2, h3');
  
  const metadataPatterns = [
    { pattern: /^(url|URL)\s*[:\-=\|]\s*(.+)$/i, key: 'canonicalUrl' },
    { pattern: /^(meta-title|Meta-Title|metatitle|metaTitle|meta title|Meta Title)\s*[:\-=\|]\s*(.+)$/i, key: 'metaTitle' },
    { pattern: /^(meta-description|Meta-Description|metadescription|metaDescription|meta description|Meta Description)\s*[:\-=\|]\s*(.+)$/i, key: 'metaDescription' },
    { pattern: /^(meta-keywords|Meta-Keywords|metakeywords|metaKeywords|meta keywords|Meta Keywords)\s*[:\-=\|]\s*(.+)$/i, key: 'metaKeywords' },
    { pattern: /^(canonicalurl|canonicalUrl|canonical url|Canonical URL)\s*[:\-=\|]\s*(.+)$/i, key: 'canonicalUrl' },
    { pattern: /^(title|Title)\s*[:\-=\|]\s*(.+)$/i, key: 'title' }
  ];
  
  // Check first 100 paragraphs
  for (let i = 0; i < Math.min(100, paragraphs.length); i++) {
    const text = paragraphs[i].textContent.trim();
    
    for (const { pattern, key } of metadataPatterns) {
      const match = text.match(pattern);
      if (match && !metadata[key]) {
        metadata[key] = match[2].trim();
        console.log(`Found ${key} at paragraph ${i}:`, metadata[key]);
        break;
      }
    }
  }
  
  // Fallback: Extract title from first heading
  if (!metadata.title && headings.length > 0) {
    for (let i = 0; i < headings.length; i++) {
      const headingText = headings[i].textContent.trim();
      const headingLower = headingText.toLowerCase();
      
      // Skip section markers
      if (headingLower === 'introduction' || 
          headingLower === 'disclaimer' || 
          headingLower === 'faq' ||
          headingLower.startsWith('url:') ||
          headingLower.startsWith('meta-')) {
        continue;
      }
      
      if (headingText && headingText.length > 5) {
        metadata.title = headingText;
        console.log('Extracted title from heading:', metadata.title);
        break;
      }
    }
  }
  
  return metadata;
}

// Extract FAQs and Disclaimer from HTML
function extractFAQsAndDisclaimer(html) {
  console.log('Extracting FAQ and Disclaimer sections...');
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = html;
  
  extractedFAQs = [];
  extractedDisclaimer = '';
  
  const allHeadings = Array.from(tempDiv.querySelectorAll('h1, h2, h3, h4, h5, h6'));
  const allParagraphs = Array.from(tempDiv.querySelectorAll('p'));
  
  let faqStartElement = null;
  let disclaimerStartElement = null;
  
  // Find FAQ section
  for (let i = 0; i < allHeadings.length; i++) {
    const text = allHeadings[i].textContent.trim().toLowerCase();
    if (text.includes('faq') || text === 'faqs:' || text.startsWith('faqs') || text === 'faq:') {
      faqStartElement = allHeadings[i];
      console.log('Found FAQ section at heading:', allHeadings[i].textContent);
      break;
    }
  }
  
  if (!faqStartElement) {
    for (let i = 0; i < allParagraphs.length; i++) {
      const text = allParagraphs[i].textContent.trim().toLowerCase();
      if (text.includes('faq') && (text.startsWith('faq') || text.includes('faqs:') || text.startsWith('faqs'))) {
        faqStartElement = allParagraphs[i];
        console.log('Found FAQ section at paragraph');
        break;
      }
    }
  }
  
  // Find Disclaimer section
  for (let i = 0; i < allHeadings.length; i++) {
    const text = allHeadings[i].textContent.trim().toLowerCase();
    if (text.includes('disclaimer') || text.startsWith('disclaimer')) {
      disclaimerStartElement = allHeadings[i];
      console.log('Found Disclaimer section at heading:', allHeadings[i].textContent);
      break;
    }
  }
  
  if (!disclaimerStartElement) {
    for (let i = 0; i < allParagraphs.length; i++) {
      const text = allParagraphs[i].textContent.trim().toLowerCase();
      if (text.includes('disclaimer') && text.startsWith('disclaimer')) {
        disclaimerStartElement = allParagraphs[i];
        console.log('Found Disclaimer section at paragraph');
        break;
      }
    }
  }
  
  // Extract FAQs
  if (faqStartElement && disclaimerStartElement) {
    const faqQuestions = [];
    let currentQuestion = null;
    let currentAnswer = [];
    
    let currentElement = faqStartElement;
    const allElementsBetween = [];
    
    // Collect all elements between FAQ and Disclaimer
    while (currentElement && currentElement !== disclaimerStartElement) {
      currentElement = currentElement.nextSibling;
      if (currentElement === disclaimerStartElement || !currentElement) break;
      
      const text = currentElement.textContent ? currentElement.textContent.trim().toLowerCase() : '';
      if (text.includes('disclaimer') && text.startsWith('disclaimer')) break;
      
      allElementsBetween.push(currentElement);
      if (allElementsBetween.length > 200) break;
    }
    
    // Process elements to extract Q&A pairs
    for (let i = 0; i < allElementsBetween.length; i++) {
      const element = allElementsBetween[i];
      const tagName = element.tagName ? element.tagName.toLowerCase() : '';
      const text = element.textContent ? element.textContent.trim() : '';
      
      if (!text || text.length === 0) continue;
      if (tagName === 'script') continue;
      if (text.toLowerCase().includes('faq schema')) continue;
      if (text.toLowerCase().includes('disclaimer') && text.toLowerCase().startsWith('disclaimer')) break;
      
      const cleanText = text.replace(/<[^>]+>/g, '').trim();
      const questionMatch = cleanText.match(/^Question:\s*(.+)$/i);
      const answerMatch = cleanText.match(/^Answer:\s*(.+)$/i);
      
      if (questionMatch) {
        if (currentQuestion && currentAnswer.length > 0) {
          faqQuestions.push({
            question: currentQuestion,
            answer: currentAnswer.join(' ').trim()
          });
        }
        currentQuestion = questionMatch[1].trim();
        currentAnswer = [];
      } else if (answerMatch) {
        const answerText = answerMatch[1].trim();
        if (answerText.length > 5) {
          currentAnswer.push(answerText);
        }
      } else if (currentQuestion) {
        if ((tagName === 'p' || tagName === 'div' || tagName === 'li') && 
            cleanText.length > 5 && 
            !cleanText.toLowerCase().includes('faq schema') &&
            !cleanText.toLowerCase().includes('disclaimer')) {
          currentAnswer.push(cleanText);
        }
      } else {
        // Check if this might be a question (H3 or question pattern)
        const questionPattern = /^(What|How|Why|When|Where|Who|Which|Is|Are|Can|Do|Does|Will|Should|Would|Could)/i;
        const isQuestionHeading = tagName === 'h3';
        const isQuestionParagraph = tagName === 'p' && cleanText.length > 5 && cleanText.length < 200 && 
          (cleanText.endsWith('?') || questionPattern.test(cleanText));
        
        if (isQuestionHeading || isQuestionParagraph) {
          currentQuestion = cleanText;
          currentAnswer = [];
        }
      }
    }
    
    // Save last FAQ
    if (currentQuestion && currentAnswer.length > 0) {
      faqQuestions.push({
        question: currentQuestion,
        answer: currentAnswer.join(' ').trim()
      });
    }
    
    // Store FAQs as array of {question, answer} objects
    if (faqQuestions.length > 0) {
      extractedFAQs = faqQuestions.map(faq => ({
        question: faq.question.trim(),
        answer: faq.answer.trim()
      }));
      console.log(`Extracted ${extractedFAQs.length} FAQs as structured data`);
    }
  }
  
  // Also check for FAQ schema in script tags
  const scripts = tempDiv.querySelectorAll('script');
  scripts.forEach((script) => {
    const scriptContent = script.textContent || script.innerHTML;
    
    if (scriptContent.includes('FAQPage') || (scriptContent.includes('@type') && scriptContent.includes('Question'))) {
      try {
        let jsonText = scriptContent.trim();
        const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          jsonText = jsonMatch[0];
          jsonText = jsonText.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
          
          const faqData = JSON.parse(jsonText);
          
          if (faqData['@type'] === 'FAQPage' && faqData.mainEntity && Array.isArray(faqData.mainEntity)) {
            const schemaFAQs = [];
            
            faqData.mainEntity.forEach((faq) => {
              if (faq['@type'] === 'Question' && faq.name) {
                let answerText = '';
                if (faq.acceptedAnswer) {
                  if (typeof faq.acceptedAnswer === 'object' && faq.acceptedAnswer.text) {
                    answerText = faq.acceptedAnswer.text;
                  } else if (typeof faq.acceptedAnswer === 'string') {
                    answerText = faq.acceptedAnswer;
                  }
                }
                
                if (answerText) {
                  schemaFAQs.push({
                    question: faq.name.trim(),
                    answer: answerText.trim()
                  });
                }
              }
            });
            
            // Use schema FAQs if we don't have any from content, or if schema has more
            if (schemaFAQs.length > 0 && (extractedFAQs.length === 0 || schemaFAQs.length > extractedFAQs.length)) {
              extractedFAQs = schemaFAQs;
              console.log(`Using FAQ schema from script tag (${schemaFAQs.length} FAQs) as structured data`);
            }
          }
        }
      } catch (error) {
        console.error('Error parsing FAQ schema:', error);
      }
    }
  });
  
  // Extract Disclaimer
  if (disclaimerStartElement) {
    const disclaimerParts = [];
    let currentElement = disclaimerStartElement.nextSibling;
    
    while (currentElement) {
      const tagName = currentElement.tagName ? currentElement.tagName.toLowerCase() : '';
      const text = currentElement.textContent ? currentElement.textContent.trim() : '';
      
      if (text.toLowerCase().includes('faq')) break;
      
      if ((tagName === 'p' || tagName === 'div') && text && text.length > 10) {
        disclaimerParts.push(text);
      }
      
      currentElement = currentElement.nextSibling;
      if (disclaimerParts.length > 20) break;
    }
    
    extractedDisclaimer = disclaimerParts.join(' ').trim();
    if (extractedDisclaimer) {
      console.log(`Extracted disclaimer: ${extractedDisclaimer.substring(0, 50)}...`);
    }
  }
}

// Display metadata preview
function displayMetadataPreview() {
  let previewHtml = '<strong>Extracted Metadata:</strong><br><br>';
  
  previewHtml += `<strong>Title:</strong> ${extractedMetadata.title || '(not found)'}<br>`;
  previewHtml += `<strong>Meta Title:</strong> ${extractedMetadata.metaTitle || '(not found)'}<br>`;
  previewHtml += `<strong>Meta Description:</strong> ${extractedMetadata.metaDescription || '(not found)'}<br>`;
  previewHtml += `<strong>Meta Keywords:</strong> ${extractedMetadata.metaKeywords || '(not found)'}<br>`;
  previewHtml += `<strong>Canonical URL:</strong> ${extractedMetadata.canonicalUrl || '(not found)'}<br>`;
  
  if (extractedFAQs && extractedFAQs.length > 0) {
    previewHtml += `<br><strong>FAQs:</strong> ${extractedFAQs.length} question(s) extracted<br>`;
    extractedFAQs.forEach((faq, index) => {
      previewHtml += `&nbsp;&nbsp;${index + 1}. ${faq.question.substring(0, 50)}${faq.question.length > 50 ? '...' : ''}<br>`;
    });
  } else {
    previewHtml += `<br><strong>FAQs:</strong> (not found)<br>`;
  }
  
  if (extractedDisclaimer) {
    previewHtml += `<strong>Disclaimer:</strong> ${extractedDisclaimer.substring(0, 100)}${extractedDisclaimer.length > 100 ? '...' : ''}<br>`;
  } else {
    previewHtml += `<strong>Disclaimer:</strong> (not found)<br>`;
  }
  
  metadataPreview.innerHTML = previewHtml;
}

// Create draft in Strapi (without publishedAt)
async function createDraftInStrapi() {
  console.log('Creating draft in Strapi...');
  showLoading(true);
  
  try {
    const config = await new Promise((resolve) => {
      chrome.storage.local.get(['strapiUrl', 'apiToken'], resolve);
    });
    
    if (!config.strapiUrl || !config.apiToken) {
      showLoading(false);
      showStatus('Please configure Strapi settings first (URL and API Token)', 'error');
      return;
    }
    
    // Prepare blog post data (draft - no publishedAt)
    const blogData = {
      data: {}
    };
    
    // Add title (required)
    let titleValue = extractedMetadata.title || '';
    if (!titleValue || titleValue.trim() === '') {
      titleValue = 'Untitled Post';
    }
    blogData.data.title = String(titleValue).trim();
    
    // Add optional metadata fields
    if (extractedMetadata.metaTitle && extractedMetadata.metaTitle.trim()) {
      blogData.data.metaTitle = extractedMetadata.metaTitle.trim();
    }
    if (extractedMetadata.metaDescription && extractedMetadata.metaDescription.trim()) {
      blogData.data.metaDescription = extractedMetadata.metaDescription.trim();
    }
    if (extractedMetadata.metaKeywords && extractedMetadata.metaKeywords.trim()) {
      blogData.data.metaKeywords = extractedMetadata.metaKeywords.trim();
    }
    if (extractedMetadata.canonicalUrl && extractedMetadata.canonicalUrl.trim()) {
      blogData.data.canonicalUrl = extractedMetadata.canonicalUrl.trim();
    }
    
    // Add disclaimer
    if (extractedDisclaimer && extractedDisclaimer.trim()) {
      blogData.data.disclaimer = extractedDisclaimer.trim();
    }
    
    // Add FAQs as structured component data (array of {question, answer} objects)
    if (extractedFAQs && extractedFAQs.length > 0) {
      // Format for Strapi component: array of objects with question and answer
      blogData.data.FAQs = extractedFAQs.map(faq => ({
        question: faq.question,
        answer: faq.answer
      }));
      console.log(`Including ${extractedFAQs.length} FAQs in blog post data as structured components`);
    }
    
    // Explicitly set publishedAt to null to ensure it's saved as draft
    blogData.data.publishedAt = null;
    
    console.log('Data being sent to Strapi:', JSON.stringify(blogData, null, 2));
    
    // Make API request to Strapi
    const collectionType = getCollectionType();
    const endpoints = [
      `${config.strapiUrl}/api/${collectionType}s`,
      `${config.strapiUrl}/api/${collectionType}`
    ];
    
    let validEndpoint = null;
    for (const endpoint of endpoints) {
      try {
        const testResponse = await fetch(endpoint, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${config.apiToken}`
          }
        });
        
        if (testResponse.status !== 404) {
          validEndpoint = endpoint;
          break;
        }
      } catch (testError) {
        console.log(`Error testing ${endpoint}:`, testError);
      }
    }
    
    const endpointsToTry = validEndpoint ? [validEndpoint] : endpoints;
    let response = null;
    let lastEndpoint = '';
    
    for (const endpoint of endpointsToTry) {
      lastEndpoint = endpoint;
      
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiToken}`
          },
          body: JSON.stringify(blogData)
        });
        
        if (response.ok) {
          break;
        }
        
        if (response.status === 405 && endpointsToTry.indexOf(endpoint) < endpointsToTry.length - 1) {
          continue;
        }
        
        break;
      } catch (fetchError) {
        console.error('Fetch error:', fetchError);
        if (endpointsToTry.indexOf(endpoint) < endpointsToTry.length - 1) {
          continue;
        }
        throw fetchError;
      }
    }
    
    if (!response || !response.ok) {
      let errorMessage = `HTTP ${response?.status || 'Network Error'}: ${response?.statusText || 'Unknown error'}`;
      
      if (response) {
        try {
          const errorData = await response.json();
          errorMessage = errorData.error?.message || errorMessage;
        } catch (e) {
          const errorText = await response.text();
          errorMessage = errorText || errorMessage;
        }
      }
      
      showLoading(false);
      showStatus(`Error creating draft: ${errorMessage}`, 'error');
      return;
    }
    
    const result = await response.json();
    console.log('Success:', result);
    
    const postId = result.data?.documentId || result.data?.id || result.data?.attributes?.documentId || result.data?.attributes?.id || 'unknown';
    const postTitle = result.data?.attributes?.title || result.data?.title || result.data?.attributes?.title || 'Blog Post';
    
    showLoading(false);
    showStatus(
      `Draft created successfully!\nID: ${postId}\nTitle: ${postTitle}\n\nNote: Content field is empty. Please add content manually in Strapi using CKEditor.`,
      'success'
    );
    
    // Clear form after successful creation
    setTimeout(() => {
      resetForm();
    }, 5000);
    
  } catch (error) {
    console.error('Error creating draft:', error);
    showLoading(false);
    showStatus(`Error creating draft: ${error.message}`, 'error');
  }
}

