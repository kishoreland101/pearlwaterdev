# LIS Report Generator - Graph Feature Documentation

## New Features Added

### 1. **"Create a Graph" Button**
Located in the report toolbar, beneath the table headers for each section.

**Features:**
- Pie Chart - Display data as a pie chart
- Bar Chart - Display data as a bar chart  
- Line Chart - Display data as a line chart

### 2. **Graph Modal Popup**
When the "Create a Graph" button is clicked, a modal popup appears with three main elements:

#### Graph Type Selector
- Dropdown menu to select chart type:
  - Pie Chart
  - Bar Chart
  - Line Chart

#### Column Selection (2 Dropdowns)
1. **Label Column (X-axis / Labels)**
   - Select which column will be used for chart labels
   
2. **Value Column (Y-axis / Values)**
   - Select which column contains numeric values to chart

#### Submit & Cancel Buttons
- **Submit Button**: Generates the selected graph
- **Cancel Button**: Closes the modal without generating a chart

### 3. **Graph Display**
Generated charts appear at the bottom of each report section in a responsive container with:
- Title showing the columns being compared
- Interactive legend
- Responsive design suitable for printing

## Technical Implementation Details

### Backend Changes (server.cjs)

1. **Chart.js Library Integration**
   - Added Chart.js 3.9.1 from CDN
   - `<script src="https://cdn.jsdelivr.net/npm/chart.js@3.9.1/dist/chart.min.js"></script>`

2. **HTML Structure Enhancements**
   - Added "Create a Graph" button to section toolbar
   - Added graph modal with form controls
   - Added canvas container for chart rendering
   - Added CSS styles for modal and buttons

3. **CSS Additions**
   - `.btn-graph` - Blue button style for graph creation
   - `.graph-modal` - Full-screen overlay modal styling
   - `.graph-modal-content` - Modal window content box
   - `.graph-form-group` - Form field grouping
   - `.graph-container` - Chart display container

4. **JavaScript Functions**
   - `openGraphModal(si)` - Opens the graph configuration modal
   - `closeGraphModal(si)` - Closes the graph modal
   - `generateGraph(si)` - Generates chart from selected columns
   - `chartInstances` - Global object storing Chart.js instances

### Data Processing

The graph generation process:
1. Extracts data from all rows in the current section
2. Filters out non-numeric values
3. Builds label and data arrays from selected columns
4. Applies automatic color palette (9 distinct colors)
5. Creates responsive Chart.js instance
6. Displays in the graph container below the data table

## Usage Guide

### For End Users

1. Generate a report with LIS data
2. Scroll through the report and find a data section with the data table
3. Click the **"📊 Create a Graph"** button in the toolbar
4. A modal appears - select:
   - Graph type (Pie, Bar, or Line)
   - Label column (e.g., Student Name)
   - Value column (e.g., Score)
5. Click **Submit**
6. The chart appears below the table
7. Click **Cancel** anytime to close the modal

### For Developers

To modify the graph feature:

1. **Change Chart Types**: Modify the graph type options in the modal HTML
2. **Adjust Colors**: Edit the `backgroundColor` and `borderColor` arrays in `generateGraph()`
3. **Customize Chart Options**: Modify the `chartConfig.options` object in `generateGraph()`
4. **Add More Columns**: The column dropdowns are auto-generated from section columns

## Chart Type Details

### Pie Chart
- Best for: Showing proportions and percentages
- Shows: Percentage of total for each value
- Colors: 9-color palette with transparency

### Bar Chart
- Best for: Comparing values across categories
- Shows: Vertical bars for each label
- Includes: Y-axis with values and X-axis with labels

### Line Chart
- Best for: Showing trends over time or across ordered categories
- Shows: Connected line with data points
- Includes: Y-axis with values and X-axis with labels

## Browser Compatibility

- Chrome/Chromium: Full support
- Firefox: Full support
- Safari: Full support
- Edge: Full support
- Requires: ES6 JavaScript support

## Performance Notes

- Chart.js loads from CDN (approximately 50KB gzipped)
- Charts are destroyed and recreated when needed
- Memory is managed through `chartInstances` object
- Multiple charts can be displayed simultaneously

## Customization Options

### Available Features
- Multiple charts per report section
- Real-time column value parsing
- Automatic numeric filtering
- Responsive chart sizing
- Print-friendly graph styling

### Future Enhancement Ideas
- Export charts as images
- Custom color selection
- Date/time axis support
- Multiple dataset charts
- Chart annotations and notes
