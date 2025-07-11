import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import screenshot from "screenshot-desktop";
import { windowManager } from "node-window-manager";
import Tesseract from "tesseract.js";
import sharp from "sharp";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class RevitMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: "revit-screen-capture",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
  }

  // Registers handlers for listing available tools and handling tool calls.
  // Maps tool names to their respective handler functions.
  setupToolHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "capture_revit_window",
            description: "Capture and analyze the current Revit window",
            inputSchema: {
              type: "object",
              properties: {
                analyze_text: {
                  type: "boolean",
                  description: "Whether to perform OCR text extraction",
                  default: true,
                },
                focus_area: {
                  type: "string",
                  description: "Specific area to focus on (properties, warnings, viewport, etc.)",
                  enum: ["full", "properties", "warnings", "viewport", "ribbon"],
                  default: "full",
                },
                save_image: {
                  type: "boolean",
                  description: "Whether to save the captured image locally",
                  default: false,
                },
              },
            },
          },
          {
            name: "find_revit_windows",
            description: "Find all open Revit windows and their details",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
          {
            name: "analyze_revit_ui",
            description: "Analyze specific UI elements in the captured Revit window",
            inputSchema: {
              type: "object",
              properties: {
                element_type: {
                  type: "string",
                  description: "Type of UI element to analyze",
                  enum: ["warnings", "properties", "selection", "parameters", "view_settings"],
                  default: "warnings",
                },
              },
            },
          },
        ],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "capture_revit_window":
            return await this.captureRevitWindow(args);
          case "find_revit_windows":
            return await this.findRevitWindows();
          case "analyze_revit_ui":
            return await this.analyzeRevitUI(args);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error.message}`,
            },
          ],
        };
      }
    });
  }

  // Finds all open windows with titles containing 'revit' or 'autodesk'.
  // Returns details (id, title, bounds, visibility, etc.) for each Revit window found.
  async findRevitWindows() {
    try {
      const windows = windowManager.getWindows();
      const revitWindows = windows.filter(window => {
        const title = window.getTitle().toLowerCase();
        return title.includes('revit') || title.includes('autodesk');
      });

      const windowDetails = revitWindows.map(window => ({
        id: window.id,
        title: window.getTitle(),
        bounds: window.getBounds(),
        isVisible: window.isVisible(),
        isMinimized: window.isMinimized(),
        processId: window.processId,
      }));

      return {
        content: [
          {
            type: "text",
            text: `Found ${revitWindows.length} Revit windows:\n${JSON.stringify(windowDetails, null, 2)}`,
          },
        ],
      };
    } catch (error) {
      throw new Error(`Failed to find Revit windows: ${error.message}`);
    }
  }

  // Captures a screenshot of the active Revit window.
  // Optionally performs OCR and UI analysis, and can save the image.
  // Returns analysis results and the captured image (as base64).
  async captureRevitWindow(args = {}) {
    const { analyze_text = true, focus_area = "full", save_image = false } = args;

    try {
      // Find active Revit window
      const revitWindow = await this.getActiveRevitWindow();
      if (!revitWindow) {
        throw new Error("No active Revit window found");
      }

      // Bring Revit window to front
      revitWindow.bringToTop();
      
      // Wait a moment for window to come to front
      await new Promise(resolve => setTimeout(resolve, 500));

      // Capture the window
      const windowBounds = revitWindow.getBounds();
      const screenshotPath = await this.captureWindow(windowBounds, focus_area);

      let analysisResult = {
        window_title: revitWindow.getTitle(),
        capture_area: focus_area,
        image_path: screenshotPath,
        bounds: windowBounds,
      };

      // Perform OCR if requested
      if (analyze_text) {
        analysisResult.extracted_text = await this.performOCR(screenshotPath);
        analysisResult.ui_analysis = await this.analyzeUI(analysisResult.extracted_text);
      }

      // Save image if requested
      if (save_image) {
        const savedPath = await this.saveImage(screenshotPath);
        analysisResult.saved_image_path = savedPath;
      }

      // Read image as base64 for Claude
      const imageBuffer = await fs.readFile(screenshotPath);
      const base64Image = imageBuffer.toString('base64');

      return {
        content: [
          {
            type: "text",
            text: `Captured Revit window: ${revitWindow.getTitle()}\n\nAnalysis Results:\n${JSON.stringify(analysisResult, null, 2)}`,
          },
          {
            type: "image",
            data: base64Image,
            mimeType: "image/png",
          },
        ],
      };
    } catch (error) {
      throw new Error(`Failed to capture Revit window: ${error.message}`);
    }
  }

  // Captures the Revit window and extracts text.
  // Analyzes the extracted text for a specific UI element type (e.g., warnings, properties).
  // Returns the analysis for the requested element type.
  async analyzeRevitUI(args = {}) {
    const { element_type = "warnings" } = args;

    try {
      // First capture the window
      const captureResult = await this.captureRevitWindow({ analyze_text: true });
      
      // Extract text from the capture result
      const textContent = captureResult.content.find(c => c.type === "text")?.text || "";
      
      // Parse the analysis results
      const analysisMatch = textContent.match(/Analysis Results:\n(.*)/s);
      if (!analysisMatch) {
        throw new Error("Could not parse capture results");
      }

      const analysisData = JSON.parse(analysisMatch[1]);
      const extractedText = analysisData.extracted_text || "";

      // Analyze specific UI elements
      const uiAnalysis = await this.analyzeSpecificElement(extractedText, element_type);

      return {
        content: [
          {
            type: "text",
            text: `UI Analysis for ${element_type}:\n${JSON.stringify(uiAnalysis, null, 2)}`,
          },
        ],
      };
    } catch (error) {
      throw new Error(`Failed to analyze Revit UI: ${error.message}`);
    }
  }

  // Finds all visible, non-minimized Revit windows.
  // Returns the active one if available, otherwise the first found.
  async getActiveRevitWindow() {
    const windows = windowManager.getWindows();
    const revitWindows = windows.filter(window => {
      const title = window.getTitle().toLowerCase();
      return (title.includes('revit') || title.includes('autodesk')) && 
             window.isVisible() && 
             !window.isMinimized();
    });

    if (revitWindows.length === 0) {
      return null;
    }

    // Return the first visible Revit window, or the active one
    return revitWindows.find(w => w.isActive()) || revitWindows[0];
  }

  // Takes a screenshot of the desktop, crops it to the Revit window bounds and focus area.
  // Optimizes the image for OCR and saves it to a temporary directory.
  // Returns the file path of the processed image.
  async captureWindow(bounds, focusArea = "full") {
    const tempDir = path.join(__dirname, "temp");
    await fs.mkdir(tempDir, { recursive: true });

    const timestamp = Date.now();
    const filename = `revit_capture_${timestamp}.png`;
    const filepath = path.join(tempDir, filename);

    // Take screenshot of the specific window area
    await screenshot({
      filename: filepath,
      format: 'png',
      screen: 0, // Primary screen
      quality: 100,
    });

    // Crop to window bounds and focus area if needed
    let processedImage = sharp(filepath);
    
    if (focusArea !== "full") {
      const cropArea = this.calculateCropArea(bounds, focusArea);
      processedImage = processedImage.extract(cropArea);
    }

    // Optimize image for OCR
    await processedImage
      .png({ quality: 100 })
      .sharpen()
      .toFile(filepath);

    return filepath;
  }

  // Calculates the crop rectangle for a given focus area (e.g., properties, warnings).
  // Returns the crop area as an object with left, top, width, and height.
  calculateCropArea(bounds, focusArea) {
    // These are approximate areas based on typical Revit UI layout
    const { width, height } = bounds;
    
    switch (focusArea) {
      case "properties":
        return {
          left: Math.floor(width * 0.8),
          top: Math.floor(height * 0.15),
          width: Math.floor(width * 0.2),
          height: Math.floor(height * 0.7),
        };
      case "warnings":
        return {
          left: Math.floor(width * 0.2),
          top: Math.floor(height * 0.85),
          width: Math.floor(width * 0.6),
          height: Math.floor(height * 0.15),
        };
      case "viewport":
        return {
          left: Math.floor(width * 0.2),
          top: Math.floor(height * 0.15),
          width: Math.floor(width * 0.6),
          height: Math.floor(height * 0.7),
        };
      case "ribbon":
        return {
          left: 0,
          top: 0,
          width: width,
          height: Math.floor(height * 0.15),
        };
      default:
        return {
          left: 0,
          top: 0,
          width: width,
          height: height,
        };
    }
  }

  // Runs OCR (Tesseract) on the given image file.
  // Returns the extracted text.
  async performOCR(imagePath) {
    try {
      const { data: { text } } = await Tesseract.recognize(imagePath, 'eng', {
        logger: () => {}, // Suppress logging
      });
      return text.trim();
    } catch (error) {
      throw new Error(`OCR failed: ${error.message}`);
    }
  }

  // Analyzes the OCR-extracted text for warnings, properties, selection info, etc.
  // Returns a structured analysis object.
  async analyzeUI(extractedText) {
    const analysis = {
      warnings: [],
      properties: [],
      selection_info: null,
      view_settings: null,
      ribbon_tools: [],
    };

    // Parse warnings
    const warningPatterns = [
      /warning/gi,
      /error/gi,
      /conflict/gi,
      /overlap/gi,
      /missing/gi,
      /unplaced/gi,
    ];

    warningPatterns.forEach(pattern => {
      const matches = extractedText.match(pattern);
      if (matches) {
        analysis.warnings.push(...matches);
      }
    });

    // Parse properties (look for parameter-value pairs)
    const propertyMatches = extractedText.match(/([A-Za-z\s]+):\s*([^\n]+)/g);
    if (propertyMatches) {
      analysis.properties = propertyMatches.map(match => {
        const [, key, value] = match.match(/([^:]+):\s*(.+)/);
        return { parameter: key.trim(), value: value.trim() };
      });
    }

    // Look for selection information
    const selectionMatch = extractedText.match(/selected|Selection/gi);
    if (selectionMatch) {
      analysis.selection_info = "Elements appear to be selected";
    }

    return analysis;
  }

  // Analyzes the extracted text for a specific UI element type (e.g., warnings, properties).
  // Returns the relevant analysis for the requested element type.
  async analyzeSpecificElement(text, elementType) {
    const analysis = {};

    switch (elementType) {
      case "warnings":
        analysis.warnings_found = this.extractWarnings(text);
        analysis.warning_count = analysis.warnings_found.length;
        break;
      case "properties":
        analysis.parameters = this.extractProperties(text);
        analysis.parameter_count = analysis.parameters.length;
        break;
      case "selection":
        analysis.selection_info = this.extractSelectionInfo(text);
        break;
      case "view_settings":
        analysis.view_info = this.extractViewSettings(text);
        break;
      default:
        analysis.raw_text = text;
    }

    return analysis;
  }

  // Extracts lines containing warning/error/conflict keywords from the text.
  // Returns an array of warning lines.
  extractWarnings(text) {
    const warnings = [];
    const lines = text.split('\n');
    
    lines.forEach(line => {
      if (line.toLowerCase().includes('warning') || 
          line.toLowerCase().includes('error') ||
          line.toLowerCase().includes('conflict')) {
        warnings.push(line.trim());
      }
    });

    return warnings;
  }

  // Extracts parameter-value pairs from the text (e.g., "Width: 3000").
  // Returns an array of property objects.
  extractProperties(text) {
    const properties = [];
    const propertyMatches = text.match(/([A-Za-z\s]+):\s*([^\n]+)/g);
    
    if (propertyMatches) {
      propertyMatches.forEach(match => {
        const [, key, value] = match.match(/([^:]+):\s*(.+)/);
        properties.push({
          parameter: key.trim(),
          value: value.trim(),
        });
      });
    }

    return properties;
  }

  // Extracts information about selected elements from the text.
  // Returns an object with selection status, element count, and types.
  extractSelectionInfo(text) {
    const selectionInfo = {
      has_selection: text.toLowerCase().includes('selected'),
      element_count: 0,
      element_types: [],
    };

    // Try to extract element count
    const countMatch = text.match(/(\d+)\s*(?:element|item|object)/i);
    if (countMatch) {
      selectionInfo.element_count = parseInt(countMatch[1]);
    }

    // Try to extract element types
    const typeMatches = text.match(/(wall|door|window|room|floor|ceiling|roof|column|beam|family)/gi);
    if (typeMatches) {
      selectionInfo.element_types = [...new Set(typeMatches.map(t => t.toLowerCase()))];
    }

    return selectionInfo;
  }

  // Extracts view-related settings (name, scale, detail level) from the text.
  // Returns an object with view info.
  extractViewSettings(text) {
    const viewInfo = {
      view_name: null,
      scale: null,
      detail_level: null,
      visual_style: null,
    };

    // Extract view name
    const viewMatch = text.match(/(?:view|plan|elevation|section):\s*([^\n]+)/i);
    if (viewMatch) {
      viewInfo.view_name = viewMatch[1].trim();
    }

    // Extract scale
    const scaleMatch = text.match(/scale:\s*([^\n]+)/i);
    if (scaleMatch) {
      viewInfo.scale = scaleMatch[1].trim();
    }

    // Extract detail level
    const detailMatch = text.match(/detail\s*level:\s*([^\n]+)/i);
    if (detailMatch) {
      viewInfo.detail_level = detailMatch[1].trim();
    }

    return viewInfo;
  }

  // Copies the image from the temp directory to a persistent 'saved_captures' directory.
  // Returns the new file path.
  async saveImage(sourcePath) {
    const saveDir = path.join(__dirname, "saved_captures");
    await fs.mkdir(saveDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `revit_capture_${timestamp}.png`;
    const savePath = path.join(saveDir, filename);

    await fs.copyFile(sourcePath, savePath);
    return savePath;
  }

  // Starts the server using stdio transport.
  // Keeps the process running to listen for requests.
  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    process.stdin.resume();
  }
}

// Start the server
const server = new RevitMCPServer();
server.start().catch(console.error);