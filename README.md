# Claude Desktop MCP Server Setup

This README provides the steps to configure the MCP (Model Context Protocol) server for Claude Desktop. The MCP server enables real-time interaction with the Revit application.

## Prerequisites

- **Claude Desktop** installed on your system.
- **Node.js** installed on your system.
- **Revit MCP Server** setup on your machine.
- **Directory structure** should match the paths in the configuration file.

## Configuration

1. **Navigate to Claude Desktop's Configuration File**:
   
   The MCP server configuration is typically stored in the Claude Desktop configuration file (e.g., `config.json` or a similar config file).

2. **Add MCP Server Configuration**:

   In your configuration file, add the following `mcpServers` section:

   ```json
   {
     "mcpServers": {
       "revit-mcp": {
         "command": "node",
         "args": ["<path-to-your-project>/src/index.js"],
         "cwd": "<path-to-your-project>"
       }
     }
   }

# Install dependencies
npm install

# To run project 
npm run start
