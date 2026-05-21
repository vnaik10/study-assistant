import JSZip from "jszip";

export async function extractPptxText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const zip = new JSZip();
  const loadedZip = await zip.loadAsync(buf);

  // Filter for slide XML files (e.g., ppt/slides/slide1.xml, ppt/slides/slide2.xml)
  const slidePaths = Object.keys(loadedZip.files).filter(
    (path) => path.startsWith("ppt/slides/slide") && path.endsWith(".xml")
  );

  // Extract the slide number from the path to sort them chronologically
  // e.g. "ppt/slides/slide10.xml" -> 10
  slidePaths.sort((a, b) => {
    const aMatch = a.match(/slide(\d+)\.xml$/);
    const bMatch = b.match(/slide(\d+)\.xml$/);
    const numA = aMatch ? parseInt(aMatch[1], 10) : 0;
    const numB = bMatch ? parseInt(bMatch[1], 10) : 0;
    return numA - numB;
  });

  let fullText = "";

  for (const path of slidePaths) {
    const slideFile = loadedZip.file(path);
    if (!slideFile) continue;

    const xmlContent = await slideFile.async("text");
    
    // Parse the XML string using the browser's native DOMParser
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlContent, "application/xml");
    
    // Text in PPTX is stored inside <a:t> tags
    const textNodes = doc.getElementsByTagName("a:t");
    
    let slideText = "";
    for (let i = 0; i < textNodes.length; i++) {
      if (textNodes[i].textContent) {
        slideText += textNodes[i].textContent + " ";
      }
    }

    if (slideText.trim()) {
      fullText += slideText.trim() + "\n\n";
    }
  }

  return fullText.trim();
}
